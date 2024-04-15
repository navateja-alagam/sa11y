/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { AxeResults, log, useCustomRules } from '@sa11y/common';
import { getViolationsJSDOM } from '@sa11y/assert';
import { A11yError, exceptionListFilterSelectorKeywords } from '@sa11y/format';
import { isTestUsingFakeTimer } from './matcher';
import { expect } from '@jest/globals';
import { adaptA11yConfig, adaptA11yConfigCustomRules } from './setup';
import { defaultRuleset } from '@sa11y/preset-rules';
import { Mutex, withTimeout, E_CANCELED } from 'async-mutex';

/**
 * Options for Automatic checks to be passed to {@link registerSa11yAutomaticChecks}
 */
export type AutoCheckOpts = {
    runAfterEach?: boolean;
    cleanupAfterEach?: boolean;
    consolidateResults?: boolean;
    // TODO (feat): add support for optional exclusion of selected tests
    // excludeTests?: string[];
    // List of test file paths (as regex) to filter for automatic checks
    filesFilter?: string[];
};

/**
 * Default options when {@link registerSa11yAutomaticChecks} is invoked
 */
const defaultAutoCheckOpts: AutoCheckOpts = {
    runAfterEach: true,
    cleanupAfterEach: true,
    consolidateResults: true,
    filesFilter: [],
};

let originalDocumentBodyHtml: string | null = null;

export const setOriginalDocumentBodyHtml = (bodyHtml: string | null) => {
    originalDocumentBodyHtml = bodyHtml ?? null;
};

export const getOriginalDocumentBodyHtml = () => {
    return originalDocumentBodyHtml;
};

/**
 * Check if current test file needs to be skipped based on any provided filter
 */
export function skipTest(testPath: string | undefined, filesFilter?: string[]): boolean {
    if (!testPath || !filesFilter || !(filesFilter?.length > 0)) return false;
    const skipTest = filesFilter.some((fileName) => testPath.toLowerCase().includes(fileName.toLowerCase()));

    if (skipTest) {
        log(
            `Skipping automatic accessibility check on ${testPath} as it matches given files filter: ${filesFilter.toString()}`
        );
    }
    return skipTest;
}

/**
 * Run accessibility check on each element node in the body using {@link toBeAccessible}
 * @param opts - Options for automatic checks {@link AutoCheckOpts}
 */
export async function automaticCheck(opts: AutoCheckOpts = defaultAutoCheckOpts): Promise<void> {
    if (skipTest(expect.getState().testPath, opts.filesFilter)) return;

    // Skip automatic check if test is using fake timer as it would result in timeout
    if (isTestUsingFakeTimer()) {
        log('Skipping automatic accessibility check as Jest fake timer is in use.');
        return;
    }

    let violations: AxeResults = [];
    const currentDocumentHtml = document.body.innerHTML;
    if (originalDocumentBodyHtml) {
        document.body.innerHTML = originalDocumentBodyHtml;
    }
    // Create a DOM walker filtering only elements (skipping text, comment nodes etc)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let currNode = walker.firstChild();
    const customRules = useCustomRules();
    try {
        while (currNode !== null) {
            // TODO (spike): Use a logger lib with log levels selectable at runtime
            // console.log(
            //     `♿ [DEBUG] Automatically checking a11y of ${currNode.nodeName}
            //      for test "${expect.getState().currentTestName}"
            //      : ${testPath}`
            // );
            // W-10004832 - Exclude descendancy based rules from automatic checks
            if (customRules.length === 0)
                violations.push(...(await getViolationsJSDOM(currNode, adaptA11yConfig(defaultRuleset))));
            else
                violations.push(
                    ...(await getViolationsJSDOM(currNode, adaptA11yConfigCustomRules(defaultRuleset, customRules)))
                );
            currNode = walker.nextSibling();
        }

        // for (let i=0; i<mutatedNodes.length; i++) {
        //     // TODO (spike): Use a logger lib with log levels selectable at runtime
        //     // console.log(
        //     //     `♿ [DEBUG] Automatically checking a11y of ${currNode.nodeName}
        //     //      for test "${expect.getState().currentTestName}"
        //     //      : ${testPath}`
        //     // );
        //     // W-10004832 - Exclude descendancy based rules from automatic checks
        //     // console.log('FINAL  mutatedNodes.length -- ' + mutatedNodes.length);
        //     if(mutatedNodes[i].innerHTML) {
        //         console.log(' mutatedNodes[i].innerHTML -- ' +  mutatedNodes[i].innerHTML);
        //         console.log(' mutatedNodes[i].outerHTML -- ' +  mutatedNodes[i].outerHTML);
        //         // if(mutatedNodes[i].shadowRoot) {
        //         //     console.log(' mutatedNodes[i].shadowRoot.innerHTML -- ' +  mutatedNodes[i].shadowRoot.innerHTML);
        //         // }
        //     document.body.innerHTML = mutatedNodes[i].outerHTML;
        //     const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        //     let currNode = walker.firstChild();
        //     while (currNode !== null) {
        //     if (customRules.length === 0)
        //         violations.push(...(await (0, assert_1.getViolationsJSDOM)(currNode, (0, setup_1.adaptA11yConfig)(preset_rules_1.defaultRuleset))));
        //     else
        //         violations.push(...(await (0, assert_1.getViolationsJSDOM)(currNode, (0, setup_1.adaptA11yConfigCustomRules)(preset_rules_1.defaultRuleset, customRules))));
        //     currNode = walker.nextSibling();
        //     }
        // }
        // }
    } finally {
        setOriginalDocumentBodyHtml(null);
        document.body.innerHTML = currentDocumentHtml;
        if (opts.cleanupAfterEach) document.body.innerHTML = ''; // remove non-element nodes
        // TODO (spike): Disable stack trace for automatic checks.
        //  Will this affect all errors globally?
        // Error.stackTraceLimit = 0;
        if (process.env.SELECTOR_FILTER_KEYWORDS) {
            violations = exceptionListFilterSelectorKeywords(
                violations,
                process.env.SELECTOR_FILTER_KEYWORDS.split(',')
            );
        }
        A11yError.checkAndThrow(violations, { deduplicate: opts.consolidateResults });
    }
}

const mutexTimeout = 5000;
const mutex = withTimeout(new Mutex(), mutexTimeout, new Error('Timed-out waiting for axe'));

function observerCallback(mutations: MutationRecord[], _observer: MutationObserver) {
    const violations: AxeResults = []; // TODO (refactor): move to global/test scope
    for (const mutation of mutations) {
        // log('Mutation event triggered on', mutation.target.nodeName);
        for (const node of mutation.addedNodes) {
            getViolationsJSDOM(node, adaptA11yConfig(defaultRuleset))
                .then((violationErrors) => violations.push(...violationErrors))
                .catch((err) => {
                    if (err == E_CANCELED) {
                        console.log('Mutex cancelled');
                        return;
                    }
                    console.log('Error:', err);
                });
        }
    }

    A11yError.checkAndThrow(violations);

    // for (const mutation of mutations) {
    // for (const node of mutation.addedNodes) {
    // mutatedNodes.push(node);
    // }
    // }
}

// https://developer.mozilla.org/en-US/docs/Web/API/MutationObserverInit
const observerOptions: MutationObserverInit = {
    subtree: true, // extend monitoring to the entire subtree of nodes rooted at target
    childList: true, // monitor target node for addition/removal of child nodes
    // TODO (feat): Add option to enable monitoring selected attribute changes
    attributes: true, // monitor changes to the value of attributes of nodes
    characterData: true, // monitor changes to the character data contained within nodes
};

/**
 * Register accessibility checks to be run automatically after each test
 * @param opts - Options for automatic checks {@link AutoCheckOpts}
 */
export function registerSa11yAutomaticChecks(opts: AutoCheckOpts = defaultAutoCheckOpts): void {
    if (opts.runAfterEach) {
        // TODO (fix): Make registration idempotent
        const observer = new MutationObserver(observerCallback);
        log('Registering sa11y checks to be run automatically after each test');
        // afterEach(async () => {
        //     await automaticCheck(opts);
        // });
        beforeEach(() => {
            observer.observe(document.body, observerOptions);
        });

        afterEach(() => {
            observer.disconnect(); // stop mutation observer
            mutex.cancel();
            // Give time for mutex executions to complete
            // await new Promise((r) => setTimeout(r, mutexTimeout));
            // await mutex.waitForUnlock();
            // mutex.cancel(); // cancelling pending locks
            // await automaticCheck(opts);
        });
    }
}

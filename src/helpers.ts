import picomatch from "picomatch";
import type { HelperSummary } from "./types.js";

export interface HelperCommand {
  name: string;
  description: string;
  expression: string;
}

export interface SiteHelper {
  id: string;
  title: string;
  description: string;
  matches: string[];
  commands: HelperCommand[];
}

const helpers: SiteHelper[] = [
  {
    id: "x",
    title: "X / Twitter",
    description: "Helpers for reading common X/Twitter surfaces through text-first projections.",
    matches: ["https://x.com/**", "https://twitter.com/**"],
    commands: [
      {
        name: "visible-posts",
        description: "Extract visible timeline posts, authors, timestamps, and links.",
        expression: `(() => {
  const articles = [...document.querySelectorAll('article')];
  return articles.map((article, index) => {
    const text = article.innerText.trim();
    const links = [...article.querySelectorAll('a[href]')].map((a) => a.href);
    const time = article.querySelector('time')?.getAttribute('datetime') ?? null;
    return { index, text, time, links };
  }).filter((item) => item.text);
})()`
      },
      {
        name: "bookmark-links",
        description: "Collect visible bookmark candidate links from the current page.",
        expression: `(() => [...document.querySelectorAll('article a[href]')]
  .map((a) => a.href)
  .filter((href) => /\\/status\\//.test(href))
  .filter((href, index, all) => all.indexOf(href) === index))()`
      }
    ]
  },
  {
    id: "github",
    title: "GitHub",
    description: "Helpers for repository, issue, pull request, and notification pages.",
    matches: ["https://github.com/**"],
    commands: [
      {
        name: "repo-context",
        description: "Extract repository title, selected branch, page headings, and visible code links.",
        expression: `(() => ({
  title: document.title,
  headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.innerText.trim()).filter(Boolean),
  branch: document.querySelector('[data-hotkey="w"]')?.textContent?.trim() ?? null,
  codeLinks: [...document.querySelectorAll('a[href]')]
    .map((a) => ({ text: a.textContent?.trim() ?? '', href: a.href }))
    .filter((link) => link.href.includes('/blob/') || link.href.includes('/tree/'))
    .slice(0, 100)
}))()`
      },
      {
        name: "discussion-items",
        description: "Extract visible issue or PR comments as author/text blocks.",
        expression: `(() => [...document.querySelectorAll('.js-comment, .TimelineItem')]
  .map((node, index) => ({
    index,
    author: node.querySelector('.author')?.textContent?.trim() ?? null,
    text: node.textContent?.trim().replace(/\\s+/g, ' ') ?? ''
  }))
  .filter((item) => item.text))()`
      }
    ]
  },
  {
    id: "generic",
    title: "Generic page",
    description: "Baseline helpers available for any web page.",
    matches: ["http://**", "https://**"],
    commands: [
      {
        name: "links",
        description: "Extract visible links with text and href.",
        expression: `(() => [...document.querySelectorAll('a[href]')]
  .map((a) => ({ text: (a.innerText || a.textContent || '').trim(), href: a.href }))
  .filter((link) => link.text || link.href))()`
      },
      {
        name: "forms",
        description: "Extract visible form controls with labels, names, and types.",
        expression: `(() => [...document.querySelectorAll('input, textarea, select, button')]
  .map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.id || null,
    text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim(),
    value: 'value' in el ? el.value : null,
    disabled: !!el.disabled
  })))()`
      }
    ]
  }
];

export function matchingHelpers(url: string): SiteHelper[] {
  return helpers.filter((helper) =>
    helper.matches.some((pattern) => picomatch.isMatch(url, pattern, { nocase: true }))
  );
}

export function helperSummaries(url: string): HelperSummary[] {
  return matchingHelpers(url).map((helper) => ({
    id: helper.id,
    title: helper.title,
    description: helper.description,
    matches: helper.matches,
    commands: helper.commands.map((command) => ({
      name: command.name,
      description: command.description
    }))
  }));
}

export function findHelperCommand(
  url: string,
  helperId: string,
  commandName: string
): { helper: SiteHelper; command: HelperCommand } {
  const helper = matchingHelpers(url).find((candidate) => candidate.id === helperId);
  if (!helper) {
    throw new Error(`Helper ${helperId} is not available for ${url}.`);
  }
  const command = helper.commands.find((candidate) => candidate.name === commandName);
  if (!command) {
    throw new Error(`Helper ${helperId} has no command named ${commandName}.`);
  }
  return { helper, command };
}

/**
 * A GitHub PR named by URL (C20), in either of the two forms the factory has recorded one by: its
 * page (`https://github.com/o/r/pull/7`, or the same path on a GitHub Enterprise host) and its REST
 * resource (`https://api.github.com/repos/o/r/pulls/7`, or `/api/v3/repos/o/r/pulls/7` on an
 * Enterprise host), which older sessions' `pr_url` holds. Two URLs name the same PR when both read
 * and agree on host-independent owner, repository and number.
 */
import { Schema } from "effect";
import { RepoSlug } from "@repo/domain/Session";

const PAGE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/;
const RESOURCE =
  /^(?:\/api\/v3)?\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/(\d+)\/?$/;

/** The PR a URL names, as its repository and number, or `undefined` for a URL that names none. */
export const pullRequestOf = (
  url: string,
): { readonly repo: RepoSlug; readonly number: number } | undefined => {
  if (!URL.canParse(url)) return undefined;
  const path = new URL(url).pathname;
  const match = PAGE.exec(path) ?? RESOURCE.exec(path);
  const number = Number(match?.[3]);
  if (match === null || !Number.isSafeInteger(number)) return undefined;
  const slug = `${match[1]}/${match[2]}`;
  return Schema.is(RepoSlug)(slug) ? { repo: slug, number } : undefined;
};

/** Whether two URLs name the same PR: equal, or both read (`pullRequestOf`) to one repo and number. */
export const samePullRequest = (a: string, b: string): boolean => {
  if (a === b) return true;
  const left = pullRequestOf(a);
  const right = pullRequestOf(b);
  return (
    left !== undefined &&
    right !== undefined &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number
  );
};

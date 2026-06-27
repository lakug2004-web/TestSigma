import { headers as nextHeaders } from "next/headers";
import { auth } from "@/lib/auth";

const GH_API = "https://api.github.com";

export type GitHubProfile = {
  login: string;
  name: string | null;
  avatar_url: string;
  bio: string | null;
  html_url: string;
  followers: number;
  following: number;
  public_repos: number;
  total_private_repos?: number;
  company: string | null;
  location: string | null;
};

export type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
};

export type RepoStats = {
  pullRequests: number;
  commits: number;
  languages: { name: string; percent: number }[];
};

/**
 * Resolve the signed-in user's GitHub access token. Better Auth handles
 * refreshing/decrypting it from the `account` table for us.
 */
export async function getGitHubToken(): Promise<string | null> {
  const hdrs = await nextHeaders();
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session) return null;
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: { providerId: "github" },
      headers: hdrs,
    });
    return accessToken ?? null;
  } catch {
    return null;
  }
}

export async function ghFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(path.startsWith("http") ? path : `${GH_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
    cache: "no-store",
  });
}

export async function getProfile(token: string): Promise<GitHubProfile> {
  const res = await ghFetch(token, "/user");
  if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`);
  return res.json();
}

export async function getRepos(token: string): Promise<GitHubRepo[]> {
  const res = await ghFetch(
    token,
    "/user/repos?per_page=100&sort=updated&affiliation=owner&visibility=all",
  );
  if (!res.ok) throw new Error(`GitHub /user/repos failed: ${res.status}`);
  const raw: Array<GitHubRepo & { owner: { login: string } }> =
    await res.json();
  return raw.map((r) => ({ ...r, owner: r.owner.login }));
}

/** Total contributions in the last year via the GraphQL contributions graph. */
export async function getContributions(token: string): Promise<number> {
  const query = `query { viewer { contributionsCollection { contributionCalendar { totalContributions } } } }`;
  const res = await ghFetch(token, "https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return 0;
  const json = await res.json();
  return (
    json?.data?.viewer?.contributionsCollection?.contributionCalendar
      ?.totalContributions ?? 0
  );
}

/** Read total count from a paginated endpoint's `Link: ...rel="last"` header. */
function lastPageCount(res: Response): number | null {
  const link = res.headers.get("link");
  if (!link) return null;
  const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  return match ? Number(match[1]) : null;
}

export async function getRepoStats(
  token: string,
  owner: string,
  repo: string,
): Promise<RepoStats> {
  const [prRes, commitRes, langRes] = await Promise.all([
    ghFetch(
      token,
      `/search/issues?q=repo:${owner}/${repo}+is:pr&per_page=1`,
    ),
    ghFetch(token, `/repos/${owner}/${repo}/commits?per_page=1`),
    ghFetch(token, `/repos/${owner}/${repo}/languages`),
  ]);

  let pullRequests = 0;
  if (prRes.ok) pullRequests = (await prRes.json()).total_count ?? 0;

  let commits = 0;
  if (commitRes.ok) {
    const fromHeader = lastPageCount(commitRes);
    commits = fromHeader ?? (await commitRes.json()).length ?? 0;
  }

  let languages: RepoStats["languages"] = [];
  if (langRes.ok) {
    const map: Record<string, number> = await langRes.json();
    const total = Object.values(map).reduce((a, b) => a + b, 0) || 1;
    languages = Object.entries(map)
      .map(([name, bytes]) => ({
        name,
        percent: Math.round((bytes / total) * 100),
      }))
      .sort((a, b) => b.percent - a.percent);
  }

  return { pullRequests, commits, languages };
}

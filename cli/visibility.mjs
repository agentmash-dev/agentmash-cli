// Whether a checkout's GitHub repository is public, for `init` and `join`,
// which commit a room's key beside the hooks. In a public repository that
// key is anyone's: they read the room and write to it. So before either
// commits one, it asks GitHub the way anyone can, unauthenticated:
// GET /repos/{owner}/{name} answers 200 with "private": false for a public
// repository and 404 for a private or missing one, which to a stranger look
// the same. No sign-in, no token, nothing about the room leaves the machine.
//
// fetch is a parameter so the tests can be GitHub; AGENTMASH_GITHUB_API
// points a whole command at a stand-in, as the CLI tests do.

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 5_000;

/** Where GitHub's API is: AGENTMASH_GITHUB_API, for a stand-in, or GitHub's own. */
export function githubApi(env = process.env) {
  return (env.AGENTMASH_GITHUB_API || GITHUB_API).replace(/\/+$/, '');
}

/**
 * What GitHub says of `slug` (owner/name): { visibility: 'public' |
 * 'private' | 'unknown', why?, movedTo? }, `why` saying in a few words what
 * kept an answer from coming, and `movedTo` the owner/name GitHub answered
 * under when it is another: the repository was renamed or transferred, and
 * GitHub redirects the old name to it (for a public one: a private one is a
 * 404 to anyone, under any name). Never throws.
 */
export async function repoVisibility(slug, { fetch: fetchImpl = globalThis.fetch, api = githubApi(), timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  let text = '';
  try {
    res = await fetchImpl(`${api}/repos/${slug.split('/').map(encodeURIComponent).join('/')}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'agentmash-cli',
        'x-github-api-version': '2022-11-28',
        // as api() in agentmash.mjs: no keep-alive socket left for the exit to race
        connection: 'close',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // read whole whatever it says, so nothing is still arriving when the command ends
    text = await res.text();
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { visibility: 'unknown', why: timedOut ? `no answer in ${timeoutMs / 1000} s` : 'GitHub could not be reached' };
  }
  if (res.status === 404) return { visibility: 'private' };
  if (res.status === 200) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: no answer
    }
    // a renamed or transferred repository's old name redirects to the new one, which fetch follows
    const named = typeof body?.full_name === 'string' ? body.full_name.toLowerCase() : null;
    const moved = named && named !== slug.toLowerCase() ? { movedTo: named } : {};
    if (body?.private === false) return { visibility: 'public', ...moved };
    if (body?.private === true) return { visibility: 'private', ...moved };
    return { visibility: 'unknown', why: 'GitHub answered without saying' };
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return { visibility: 'unknown', why: "GitHub's hourly limit for this address is spent" };
  }
  return { visibility: 'unknown', why: `GitHub answered HTTP ${res.status}` };
}

/**
 * Whether GitHub's account `owner` is an organization: true, false, or null
 * when GitHub does not say. Asked the way anyone can, as repoVisibility asks,
 * and only when a refusal needs it said (see connect). Never throws.
 */
export async function isOrganization(owner, { fetch: fetchImpl = globalThis.fetch, api = githubApi(), timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(`${api}/users/${encodeURIComponent(owner)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'agentmash-cli',
        'x-github-api-version': '2022-11-28',
        connection: 'close',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status !== 200) return null;
    const type = JSON.parse(text)?.type;
    return type === 'Organization' ? true : type === 'User' ? false : null;
  } catch {
    return null;
  }
}

/**
 * The checkout's GitHub repositories (`slugs`, owner/name), sorted by what
 * GitHub says of each: { public, private, unknown }, `unknown` as
 * { slug, why }. Asked together, so a slow GitHub costs one timeout.
 */
export async function checkVisibility(slugs, options = {}) {
  const answers = await Promise.all(slugs.map((slug) => repoVisibility(slug, options)));
  const sorted = { public: [], private: [], unknown: [] };
  answers.forEach((answer, i) => {
    if (answer.visibility === 'unknown') sorted.unknown.push({ slug: slugs[i], why: answer.why });
    else sorted[answer.visibility].push(slugs[i]);
  });
  return sorted;
}

/** What anyone who holds a room's key can do with it, as a clause: "anyone who reads it holds the key, and …". */
export const KEY_OPENS =
  'can read the file paths, branch names, change summaries and symbol names your agents report, the first ' +
  '500 characters of each prompt and, when the room streams diffs, the changed text itself, and can write ' +
  'events into the room';

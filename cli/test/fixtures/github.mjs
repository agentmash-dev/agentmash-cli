// GitHub's API as a stranger sees it, for the commands that ask whether a
// checkout's repository is public before they commit a room key to it
// (visibility.mjs). The CLI is pointed here with AGENTMASH_GITHUB_API, so no
// test ever asks the real GitHub. `answers` is the test's to change while it
// runs, by owner/name: { status, body, headers }; anything not in it is a
// 404, a private or missing repository. An account is asked after as
// users/<owner> (whether it is an organization). Unref'd: a test file that
// started it still ends when its tests do.

import http from 'node:http';

export const PUBLIC_REPO = { status: 200, body: { private: false } };

export function startGitHub() {
  const answers = {};
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
    const repo = decodeURIComponent(url.pathname.replace(/^\/repos\//, '').replace(/^\//, '')).toLowerCase();
    const answer = answers[repo] ?? { status: 404, body: { message: 'Not Found' } };
    res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    res.end(JSON.stringify(answer.body ?? {}));
  });
  server.listen(0, '127.0.0.1');
  server.unref();
  return {
    get url() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    answers,
    requests,
    ready: new Promise((resolve) => server.once('listening', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

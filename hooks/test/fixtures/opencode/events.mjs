// What OpenCode hands a plugin's event hook, recorded from OpenCode 1.18.34's
// source (anomalyco/opencode, tag v1.18.34), not from a live run:
//
//   packages/opencode/src/plugin/index.ts L254-261   ({ event: { id, type, properties } }), for events of the
//                                                    plugin's own directory only, not waited for
//   packages/schema/src/v1/session.ts L543-595       session.created, session.updated and session.deleted:
//                                                    { sessionID, info }, info.parentID on a subagent's session
//   packages/opencode/src/session/status.ts L39-46   session.status { sessionID, status: { type: idle|busy|retry } }

import { SESSION } from './tool-execute.mjs';

export const CHILD = 'ses_2f6a1a77cffeB9mN2pQ4rS6tU8';

const info = (id, directory, extra = {}) => ({
  id,
  slug: 'brave-otter',
  projectID: 'prj_4c1e2b',
  directory,
  title: 'Give the user a role',
  version: '1.18.34',
  time: { created: 1759622400000, updated: 1759622400000 },
  ...extra,
});

/** The event hook's argument for one event. */
const event = (type, properties) => ({ event: { id: `evt_${type.replace('.', '_')}`, type, properties } });

export const sessionCreated = (directory, id = SESSION) => event('session.created', { sessionID: id, info: info(id, directory) });
/** The task tool's subagent session, started from `parent`. */
export const childCreated = (directory, parent = SESSION, id = CHILD) =>
  event('session.created', { sessionID: id, info: info(id, directory, { parentID: parent, title: 'Find where users are stored' }) });
export const sessionIdle = (id = SESSION) => event('session.status', { sessionID: id, status: { type: 'idle' } });
export const sessionDeleted = (directory, id = SESSION, extra = {}) => event('session.deleted', { sessionID: id, info: info(id, directory, extra) });

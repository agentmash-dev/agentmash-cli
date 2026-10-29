// What Kilo Code hands a plugin's event hook, recorded from Kilo Code 7.8.3's
// source (Kilo-Org/kilocode, tag v7.8.3), not from a live run:
//
//   packages/opencode/src/plugin/index.ts L265-272   ({ event: { id, type, properties } }), for events of the
//                                                    plugin's own directory only, not waited for
//   packages/opencode/src/session/session.ts L665    session.created { sessionID, info }, info.parentID on a
//                                                    subagent's session (the SDK's type lists only info)
//   packages/opencode/src/session/session.ts L745    session.deleted { sessionID, info }
//   packages/opencode/src/session/status.ts L93-94   session.status { sessionID, status: { type: idle|busy|… } },
//                                                    then session.idle { sessionID }, at the end of every turn

import { SESSION } from './tool-execute.mjs';

export const CHILD = 'ses_1f2c3a77cffeB9mN2pQ4rS6tU8';

const info = (id, directory, extra = {}) => ({
  id,
  slug: 'brave-otter',
  version: '7.8.3',
  projectID: 'prj_5d2f3c',
  directory,
  title: 'Give the user a role',
  cost: 0,
  time: { created: 1759622400000, updated: 1759622400000 },
  ...extra,
});

/** The event hook's argument for one event. */
const event = (type, properties) => ({ event: { id: `evt_${type.replace('.', '_')}`, type, properties } });

export const sessionCreated = (directory, id = SESSION) => event('session.created', { sessionID: id, info: info(id, directory) });
/** The task tool's subagent session, started from `parent`. */
export const childCreated = (directory, parent = SESSION, id = CHILD) =>
  event('session.created', { sessionID: id, info: info(id, directory, { parentID: parent, title: 'Find where users are stored' }) });
export const sessionIdle = (id = SESSION) => event('session.idle', { sessionID: id });
export const sessionDeleted = (directory, id = SESSION, extra = {}) => event('session.deleted', { sessionID: id, info: info(id, directory, extra) });

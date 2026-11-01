import { HttpError } from '../lib/errors.js';
import { Reply } from '../http/router.js';

/** Endpoints for the staff console. Every route requires a staff sign-in. */
export function registerStaffRoutes(router, { staff, authenticate }) {
  const signedIn = (ctx) => {
    ctx.actor = authenticate(ctx.req);
    // A custom header cannot be sent by another website's form or image tag,
    // so requiring it on changes blocks cross-site request forgery.
    if (ctx.req.method !== 'GET' && ctx.req.headers['x-bsd-csrf'] !== '1') {
      throw new HttpError(403, 'Missing request header.');
    }
  };
  const guards = [signedIn];

  router.get('/api/staff/me', { guards }, ({ actor }) => ({ name: actor }));
  router.get('/api/staff/cases', { guards }, () => ({ cases: staff.list() }));
  router.get('/api/staff/cases/:id', { guards }, ({ params, actor }) => staff.detail(params.id, actor));

  router.get('/api/staff/cases/:id/notice-image', { guards }, ({ params, actor }) => {
    const { mediaType, bytes } = staff.noticeImage(params.id, actor);
    return new Reply(200, bytes, { 'content-type': mediaType, 'cache-control': 'no-store' });
  });

  router.put('/api/staff/cases/:id/drafts', { guards, bodyLimit: 64 * 1024 }, ({ params, actor, body }) => staff.saveDrafts(actor, params.id, body));
  router.put('/api/staff/cases/:id/checks/:idx', { guards }, ({ params, actor, body }) => staff.setCheck(actor, params.id, params.idx, body));
  router.post('/api/staff/cases/:id/regenerate', { guards }, ({ params, actor }) => staff.regenerate(actor, params.id));
  router.post('/api/staff/cases/:id/approve', { guards }, ({ params, actor }) => staff.approve(actor, params.id));
  router.post('/api/staff/cases/:id/reject', { guards }, ({ params, actor, body }) => staff.reject(actor, params.id, body));
  router.post('/api/staff/cases/:id/send', { guards }, ({ params, actor, body }) => staff.send(actor, params.id, body));
  router.post('/api/staff/cases/:id/log', { guards }, ({ params, actor, body }) => staff.addAction(actor, params.id, body));
  router.post('/api/staff/cases/:id/outcome', { guards }, ({ params, actor, body }) => staff.recordOutcome(actor, params.id, body));
  router.post('/api/staff/cases/:id/close', { guards }, ({ params, actor }) => staff.close(actor, params.id));

  router.get('/api/staff/library', { guards }, () => staff.listLibrary());
  router.post('/api/staff/library/entries', { guards }, ({ actor, body }) => staff.saveEntry(actor, body));
  router.put('/api/staff/library/entries/:id', { guards }, ({ params, actor, body }) => staff.saveEntry(actor, body, { id: params.id }));
  router.delete('/api/staff/library/entries/:id', { guards }, ({ params, actor }) => staff.retireEntry(actor, params.id));
  router.post('/api/staff/library/utilities', { guards }, ({ actor, body }) => staff.saveUtility(actor, body));
  router.put('/api/staff/library/utilities/:id', { guards }, ({ params, actor, body }) => staff.saveUtility(actor, body, { id: params.id }));

  router.get('/api/staff/report', { guards }, () => staff.report());
}

import { createProfileApiServices, publicProfileResponse } from '../../src/server/profile-api.js';

const { persistence } = createProfileApiServices();

export default {
  fetch(request: Request) {
    let handle = '';
    try {
      handle = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) ?? '');
    } catch {
      return Response.json({ error: 'Invalid handle.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    return publicProfileResponse(request, handle, persistence);
  },
};

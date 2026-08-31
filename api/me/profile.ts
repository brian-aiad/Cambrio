import { createProfileApiServices, updateProfileResponse } from '../../src/server/profile-api.js';

const services = createProfileApiServices();

export default {
  fetch(request: Request) {
    return updateProfileResponse(request, services);
  },
};

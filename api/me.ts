import { createProfileApiServices, currentProfileResponse } from '../src/server/profile-api.js';

const services = createProfileApiServices();

export default {
  fetch(request: Request) {
    return currentProfileResponse(request, services);
  },
};

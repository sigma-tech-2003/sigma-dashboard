/**
 * Thin HTTP layer for GET /auth/me (D32). It takes no input at all -- no path parameter, no query, no
 * body -- so there is nothing to validate and no way to ask for anyone else's profile: whatever the
 * request carries, the answer is the authenticated caller's own, resolved by profileService from
 * `req.principal`.
 *
 * @param {() => object} getProfileService - called per-request, not at construction time.
 */
export function createProfileController(getProfileService) {
  return Object.freeze({
    async me(req, res, next) {
      try {
        const profile = await getProfileService().getOwnProfile(req.principal);
        res.status(200).json({ data: profile });
      } catch (error) {
        next(error);
      }
    },
  });
}

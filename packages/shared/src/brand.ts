/**
 * Product naming lives here so the app can be renamed in one place.
 * "Studio" is a working name until the real one is chosen.
 */
export const BRAND = {
  name: "Studio",
  /** Folder under the user's Documents directory that holds projects. */
  projectsFolder: "Studio",
  /** Reverse-DNS app id used by Electron and installers. */
  appId: "org.studio.app",
  /** Deep-link scheme for sign-in callbacks, e.g. studio://auth/callback */
  protocol: "studio",
} as const;

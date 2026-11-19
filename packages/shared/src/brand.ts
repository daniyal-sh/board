/** Product naming lives here so the app can be renamed in one place. */
export const BRAND = {
  /** What teachers see: "Board", made by Apollo. */
  name: "Board",
  byline: "by Apollo",
  website: "https://apollolearn.app",
  /**
   * Name on the computer: data and projects folders, installer and app id. Kept as
   * "Apollo Board" so the folders aren't a generic "Board" and existing setups keep working.
   */
  systemName: "Apollo Board",
  /** Folder under the user's Documents directory that holds projects. */
  projectsFolder: "Apollo Board",
  /** Reverse-DNS app id used by Electron and installers. */
  appId: "com.apollo.board",
  /** Earlier working name: its folders are picked up on first launch. */
  legacyName: "Studio",
} as const;

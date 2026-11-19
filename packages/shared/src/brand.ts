/** Product naming lives here so the app can be renamed in one place. */
export const BRAND = {
  name: "Apollo Board",
  /** Shown under the name: an open-source app made by the Apollo team. */
  byline: "by the Apollo team",
  /** Folder under the user's Documents directory that holds projects. */
  projectsFolder: "Apollo Board",
  /** Reverse-DNS app id used by Electron and installers. */
  appId: "com.apollo.board",
  /** Earlier working name: its folders are picked up on first launch. */
  legacyName: "Studio",
} as const;

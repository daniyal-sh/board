export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  APP_NAME: string;
  /** Origin of share pages, sign-in and the API. */
  APP_ORIGIN: string;
  /** Origin that serves published HTML. Must be a different registrable domain in production. */
  SANDBOX_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Signs OAuth state cookies and private-content tokens. */
  SESSION_SECRET: string;
  MAX_UPLOAD_MB: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export type Visibility = "private" | "unlisted" | "public";

export interface Item {
  id: string;
  owner_id: string;
  title: string;
  kind: "lab" | "web";
  visibility: Visibility;
  version: number;
  size_bytes: number;
  views: number;
  created_at: string;
  updated_at: string;
}

export type AppContext = { Bindings: Env; Variables: { user: User | null } };

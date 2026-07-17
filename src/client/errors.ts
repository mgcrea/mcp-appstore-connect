/** One entry of App Store Connect's JSON:API `errors` array. */
export type AppStoreConnectError = {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
};

export class AppStoreConnectApiError extends Error {
  override readonly name = "AppStoreConnectApiError";
  readonly status: number;
  readonly errors: AppStoreConnectError[] | unknown;

  constructor(
    message: string,
    opts: { status: number; errors?: AppStoreConnectError[] | unknown },
  ) {
    super(message);
    this.status = opts.status;
    this.errors = opts.errors;
  }
}

/** Thrown when a write tool is reached while APP_STORE_CONNECT_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set APP_STORE_CONNECT_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}

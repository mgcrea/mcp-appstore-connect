/** One entry of App Store Connect's JSON:API `errors` array. */
export type AppStoreConnectError = {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
  /**
   * Where a submission preflight actually says what is wrong.
   *
   * `POST /v1/reviewSubmissionItems` answers a version that cannot be reviewed with a single
   * `STATE_ERROR.ENTITY_STATE_INVALID` whose own detail is just "please check associated errors
   * to see why" — the reasons live here, keyed by the resource path that is incomplete: a
   * missing `primaryCategory` on the appInfo, an unanswered `usesNonExemptEncryption` on the
   * build, unpublished app privacy, unset pricing. Dropping this is what makes a submission
   * read as having failed for no stated reason.
   */
  meta?: { associatedErrors?: Record<string, AppStoreConnectError[]> };
};

/** One associated error, paired with the resource path it was filed against. */
export type AssociatedError = { resource: string; error: AppStoreConnectError };

/** Pull `meta.associatedErrors` out of a JSON:API `errors` array, flattened and paired. */
export const flattenAssociatedErrors = (errors: unknown): AssociatedError[] => {
  if (!Array.isArray(errors)) return [];
  return (errors as AppStoreConnectError[]).flatMap((outer) =>
    Object.entries(outer?.meta?.associatedErrors ?? {}).flatMap(([resource, nested]) =>
      (nested ?? []).map((error) => ({ resource, error })),
    ),
  );
};

/** `POST /v1/…` — render one associated error as `resource: CODE — detail`. */
export const formatAssociatedError = ({ resource, error }: AssociatedError): string => {
  const what = [error.code, error.detail ?? error.title].filter(Boolean).join(" — ");
  return `${resource}: ${what}`;
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

/**
 * Whether `err` is an App Store Connect answer carrying this error code, and,
 * when `detail` is given, a detail matching it. Tools use it to swap a terse
 * Apple refusal for one that names the route out; anything else rethrows as is.
 */
export const hasApiError = (err: unknown, code: string, detail?: RegExp): boolean =>
  err instanceof AppStoreConnectApiError &&
  Array.isArray(err.errors) &&
  (err.errors as AppStoreConnectError[]).some(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      e.code === code &&
      (detail === undefined || detail.test(`${e.detail ?? ""} ${e.title ?? ""}`)),
  );

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

/**
 * A local check that failed before we sent anything to Apple. Carries the state
 * it read, so the caller sees why rather than just that something was wrong.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

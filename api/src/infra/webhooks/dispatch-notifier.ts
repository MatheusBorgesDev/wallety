// Tells the delivery process that there may be events to deliver. Best effort: the
// transfer is already committed and its event is in the outbox, so a failure here only
// delays delivery until the next notification or sweep.
export type DispatchNotifier = () => Promise<void>;

export type DispatchAuth = "none" | "google-id-token";

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

type Options = {
  // Base URL of the delivery process.
  url: string;
  auth: DispatchAuth;
  // The delivery process answers only after it has drained the outbox, retries included.
  timeoutMs?: number;
  fetch?: typeof fetch;
  metadataUrl?: string;
};

export function createDispatchNotifier(options: Options): DispatchNotifier {
  const send = options.fetch ?? fetch;
  const target = new URL("/internal/dispatch", options.url).toString();

  // On Google Cloud a private service only accepts a request that carries an identity token
  // minted for it. The metadata server issues one for the service account the caller runs as.
  async function identityToken(): Promise<string> {
    const url = `${options.metadataUrl ?? METADATA_IDENTITY_URL}?audience=${encodeURIComponent(options.url)}`;
    const response = await send(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`Identity token request failed with status ${response.status}`);
    }
    return (await response.text()).trim();
  }

  return async () => {
    const headers: Record<string, string> = {};
    if (options.auth === "google-id-token") {
      headers.Authorization = `Bearer ${await identityToken()}`;
    }
    const response = await send(target, {
      method: "POST",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (!response.ok) {
      throw new Error(`Dispatch notification failed with status ${response.status}`);
    }
  };
}

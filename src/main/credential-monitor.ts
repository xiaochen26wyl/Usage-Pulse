import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { AuthStatus, CredentialState, CredentialStatus, ServiceType } from "@shared/types";
import {
  CREDENTIAL_CHECK_INTERVAL_MS,
  EXPIRING_SOON_MS,
  classifyCredentialState,
  isCredentialCheckDue,
  isCredentialUnusable
} from "@shared/credential-utils";
import { isDuplicateInCooldown } from "@shared/monitor-utils";
import { t } from "@shared/i18n";
import {
  CredentialMissingError,
  readClaudeCredential,
  readCodexCredential,
  readCursorCredential,
  type RawCredential
} from "@main/credential-provider";
import { buildPlainAlertFlex } from "@shared/line-templates";
import { sendLineBroadcast } from "@main/line-notifier";
import { sendPlainDesktopNotification } from "@main/notifiers";
import { credentialStore, notificationStore, settingsStore, type CredentialRecord } from "@main/store";
import { SERVICE_LABELS } from "./config";

const SERVICES: ServiceType[] = ["cursor", "claude", "codex"];

const enabledKeyMap: Record<ServiceType, "enableCursorMonitoring" | "enableClaudeMonitoring" | "enableCodexMonitoring"> = {
  cursor: "enableCursorMonitoring",
  claude: "enableClaudeMonitoring",
  codex: "enableCodexMonitoring"
};

// The proactive sweep (checkAll/checkIfDue) must never probe a service the
// user opted out of; a manually-triggered check() (re-detect button, setup-
// token flow) stays ungated since the UI that reaches it is itself hidden
// when the service is disabled.
const enabledServices = (): ServiceType[] => {
  const settings = settingsStore.get();
  return SERVICES.filter((service) => settings[enabledKeyMap[service]]);
};

const nowIso = () => new Date().toISOString();

const readers: Record<ServiceType, () => Promise<RawCredential>> = {
  cursor: readCursorCredential,
  claude: readClaudeCredential,
  codex: readCodexCredential
};

const fingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");

// A credential the provider refused to hand over. "missing" is the ordinary
// not-logged-in case; anything else (an unreadable state.vscdb, API-key-only
// mode) is a real fault worth showing the message for. Classified by error
// type rather than by matching on message text, so the message itself is
// free to be localized.
const classifyFailure = (error: Error): CredentialState =>
  error instanceof CredentialMissingError ? "missing" : "error";

interface Probe {
  status: CredentialStatus;
  record: CredentialRecord | null;
}

/**
 * Re-reads every credential from its source on a slow cycle.
 *
 * Before this existed, expiry was purely reactive: the app only learned a login
 * had lapsed when a quota call came back 401, which could be hours after the
 * fact. The sweep compares a SHA-256 fingerprint against the previous one to
 * spot a rotation, and parses the credential's own expiry to spot a genuinely
 * dead token — the two answer different questions, and neither alone is enough.
 */
export class CredentialMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Record<ServiceType, Promise<CredentialStatus> | null> = { cursor: null, claude: null, codex: null };
  private refreshQuota: ((service: ServiceType) => Promise<unknown>) | null = null;

  /**
   * Injected rather than imported so this module never depends on the monitor
   * engine, which would close an import cycle through the store.
   */
  setQuotaRefresher(refresher: (service: ServiceType) => Promise<unknown>): void {
    this.refreshQuota = refresher;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.checkAll().catch((error) => this.emit("error", error));
    }, CREDENTIAL_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Cached view, safe to answer an IPC call with — does no disk or Keychain I/O. */
  getStatus(): AuthStatus {
    return {
      cursor: this.cachedStatus("cursor"),
      claude: this.cachedStatus("claude"),
      codex: this.cachedStatus("codex")
    };
  }

  async checkAll(): Promise<AuthStatus> {
    await Promise.all(enabledServices().map((service) => this.check(service)));
    const status = this.getStatus();
    this.emit("auth", status);
    return status;
  }

  /**
   * Runs a sweep only if one is overdue.
   *
   * setInterval does not advance while the machine sleeps, so a laptop closed
   * overnight would otherwise skip its sweeps entirely and wake up reporting a
   * credential state from the previous day.
   */
  async checkIfDue(): Promise<void> {
    const due = enabledServices().some((service) =>
      isCredentialCheckDue(credentialStore.get(service)?.checkedAt ?? null, Date.now())
    );
    if (due) {
      await this.checkAll();
    }
  }

  async check(service: ServiceType, options: { refreshQuota?: boolean } = {}): Promise<CredentialStatus> {
    const existing = this.inFlight[service];
    if (existing) {
      return existing;
    }

    const run = this.runCheck(service, options).finally(() => {
      this.inFlight[service] = null;
    });
    this.inFlight[service] = run;
    return run;
  }

  private async runCheck(
    service: ServiceType,
    options: { refreshQuota?: boolean }
  ): Promise<CredentialStatus> {
    const previous = credentialStore.get(service);
    const probe = this.probe(service, previous, await this.read(service));

    // A quota request has already just been made by a deliberate manual flow.
    // Refresh the credential row without spending another API request.
    if (options.refreshQuota === false) {
      return this.commit(service, probe);
    }

    const rotated = Boolean(previous && probe.record && previous.fingerprint !== probe.record.fingerprint);
    const troubled = isCredentialUnusable(probe.status.state);

    if (!rotated && !troubled) {
      return this.commit(service, probe);
    }

    // Give the credential a chance to fix itself: hitting the quota API is what
    // normally prompts the IDE to refresh a lapsed token. Only if it still looks
    // dead afterwards has it genuinely failed to renew.
    await this.refresh(service);
    const recheck = this.probe(service, previous, await this.read(service));
    const settled = this.commit(service, recheck);

    if (isCredentialUnusable(settled.state)) {
      this.notifyUnusable(service, settled);
    }

    this.emit("auth", this.getStatus());
    return settled;
  }

  private async read(service: ServiceType): Promise<RawCredential | Error> {
    try {
      return await readers[service]();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private probe(service: ServiceType, previous: CredentialRecord | null, result: RawCredential | Error): Probe {
    const checkedAt = nowIso();

    if (result instanceof Error) {
      return {
        record: null,
        status: {
          service,
          state: classifyFailure(result),
          expiresAt: null,
          rotatedAt: previous?.rotatedAt ?? null,
          checkedAt,
          message: result.message
        }
      };
    }

    const digest = fingerprint(result.token);
    const rotated = Boolean(previous && previous.fingerprint !== digest);
    const state = classifyCredentialState(result.expiresAt, Date.now(), EXPIRING_SOON_MS);
    const rotatedAt = rotated ? checkedAt : previous?.rotatedAt ?? null;

    return {
      record: {
        fingerprint: digest,
        expiresAt: result.expiresAt,
        rotatedAt,
        checkedAt,
        state
      },
      status: { service, state, expiresAt: result.expiresAt, rotatedAt, checkedAt }
    };
  }

  private commit(service: ServiceType, probe: Probe): CredentialStatus {
    if (probe.record) {
      credentialStore.set(service, probe.record);
      return probe.status;
    }

    // The credential could not be read this time. Keep the last known
    // fingerprint so a later successful read can still tell rotation apart from
    // a first sighting, but record the failure state and timestamp.
    const previous = credentialStore.get(service);
    credentialStore.set(service, {
      fingerprint: previous?.fingerprint ?? "",
      expiresAt: null,
      rotatedAt: probe.status.rotatedAt,
      checkedAt: probe.status.checkedAt,
      state: probe.status.state
    });
    return probe.status;
  }

  private async refresh(service: ServiceType): Promise<void> {
    if (!this.refreshQuota) {
      return;
    }
    try {
      await this.refreshQuota(service);
    } catch {
      // A failed quota call is itself evidence the credential is dead; the
      // re-probe that follows is what decides whether to notify.
    }
  }

  private notifyUnusable(service: ServiceType, status: CredentialStatus): void {
    const settings = settingsStore.get();
    const key = `${status.state}|${status.expiresAt ?? ""}`;
    const last = notificationStore.get(`credential:${service}`);
    if (isDuplicateInCooldown(last, key, settings.notifyCooldownMinutes * 60_000, Date.now())) {
      return;
    }
    notificationStore.set(`credential:${service}`, key, nowIso());

    const body = t(settings.language, "notification.credentialExpired", {
      service: SERVICE_LABELS[service]
    });

    const title = t(settings.language, "notification.title");
    sendPlainDesktopNotification(title, body);
    void sendLineBroadcast(
      buildPlainAlertFlex({
        service,
        serviceLabel: SERVICE_LABELS[service],
        title,
        body,
        lang: settings.language
      })
    );
  }

  private cachedStatus(service: ServiceType): CredentialStatus {
    const record = credentialStore.get(service);
    if (!record) {
      return {
        service,
        state: "missing",
        expiresAt: null,
        rotatedAt: null,
        checkedAt: ""
      };
    }
    return {
      service,
      state: record.state,
      expiresAt: record.expiresAt,
      rotatedAt: record.rotatedAt,
      checkedAt: record.checkedAt
    };
  }
}

export const credentialMonitor = new CredentialMonitor();

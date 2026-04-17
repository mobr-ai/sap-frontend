import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Button from "react-bootstrap/Button";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import "../styles/AuthPage.css";

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
const LAST_WALLET_KEY = "sap_last_solana_wallet";

function withBase(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (!API_BASE) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

function truncateKey(value, left = 4, right = 4) {
  if (!value || value.length <= left + right + 3) return value || "";
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function normalizeErrorMessage(err, fallback = "walletAuthFailed") {
  const msg =
    err?.message ||
    err?.error?.message ||
    err?.name ||
    err?.toString?.() ||
    fallback;

  if (typeof msg !== "string") return fallback;

  if (
    msg.includes("User rejected") ||
    msg.includes("User declined") ||
    msg.includes("rejected the request") ||
    msg.includes("cancelled") ||
    msg.includes("canceled")
  ) {
    return "wallet.userRejected";
  }

  return msg;
}

function getWalletIcon(walletName) {
  const normalized = (walletName || "").toLowerCase();

  if (normalized.includes("phantom")) return "/icons/phantom.png";
  if (normalized.includes("solflare")) return "/icons/solflare.png";

  return "/icons/solana.png";
}

export default function SolanaWalletLogin({
  onLogin,
  showToast,
  disabled = false,
}) {
  const { t, i18n } = useTranslation();

  const {
    publicKey,
    connected,
    connecting,
    disconnect,
    connect,
    wallet,
    wallets,
    select,
    signMessage,
  } = useWallet();

  const walletModal = useWalletModal();
  const setVisible = walletModal?.setVisible;

  const [authenticating, setAuthenticating] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [isWalletButtonHovered, setIsWalletButtonHovered] = useState(false);
  const [connectRequestId, setConnectRequestId] = useState(0);
  const [restoreAttempted, setRestoreAttempted] = useState(false);

  const prevConnectedRef = useRef(false);
  const attemptedAddressRef = useRef("");
  const authInFlightRef = useRef(false);
  const connectInFlightRef = useRef(false);
  const manualConnectRequestedRef = useRef(false);

  const address = useMemo(() => publicKey?.toBase58() || "", [publicKey]);
  const walletName = wallet?.adapter?.name || t("wallet.solanaDefaultName");

  const availableWalletNames = useMemo(
    () =>
      new Set(
        (wallets || []).map((entry) => entry?.adapter?.name).filter(Boolean),
      ),
    [wallets],
  );

  const hasBrowserWalletFlow = useMemo(
    () => typeof setVisible === "function" && (wallets?.length || 0) > 0,
    [setVisible, wallets],
  );

  const currentWalletIcon = useMemo(
    () => getWalletIcon(walletName),
    [walletName],
  );

  const resetAttempt = useCallback(() => {
    attemptedAddressRef.current = "";
    authInFlightRef.current = false;
  }, []);

  useEffect(() => {
    if (wallet?.adapter?.name) {
      localStorage.setItem(LAST_WALLET_KEY, wallet.adapter.name);
    }
  }, [wallet]);

  useEffect(() => {
    if (restoreAttempted) return;
    setRestoreAttempted(true);

    if (wallet?.adapter?.name || connected || connecting) return;

    const lastWallet = localStorage.getItem(LAST_WALLET_KEY);
    if (!lastWallet) return;
    if (!availableWalletNames.has(lastWallet)) return;

    try {
      select(lastWallet);
      setConnectRequestId((n) => n + 1);
    } catch {
      localStorage.removeItem(LAST_WALLET_KEY);
    }
  }, [
    restoreAttempted,
    wallet,
    connected,
    connecting,
    availableWalletNames,
    select,
  ]);

  useEffect(() => {
    if (!prevConnectedRef.current && connected && address) {
      showToast?.(
        t("wallet.connectedToast", {
          address: truncateKey(address, 6, 6),
        }),
        "success",
      );
    }

    if (prevConnectedRef.current && !connected) {
      showToast?.(t("wallet.disconnectedToast"), "secondary");
      resetAttempt();
      setIsWalletButtonHovered(false);
    }

    prevConnectedRef.current = connected;
  }, [connected, address, resetAttempt, showToast, t]);

  useEffect(() => {
    if (!wallet) return;
    if (connected || connecting || disabled) return;
    if (
      connectRequestId === 0 &&
      restoreAttempted &&
      !manualConnectRequestedRef.current
    ) {
      return;
    }
    if (connectInFlightRef.current) return;

    let cancelled = false;

    const run = async () => {
      connectInFlightRef.current = true;
      setAutoConnecting(true);

      try {
        await connect();
      } catch (err) {
        if (!cancelled) {
          showToast?.(
            t(normalizeErrorMessage(err, "wallet.connectionFailed")),
            "danger",
          );
        }
      } finally {
        connectInFlightRef.current = false;
        if (!cancelled) {
          setAutoConnecting(false);
          manualConnectRequestedRef.current = false;
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [
    wallet,
    connected,
    connecting,
    disabled,
    connect,
    connectRequestId,
    restoreAttempted,
    showToast,
    t,
  ]);

  const authenticateWallet = useCallback(
    async ({ force = false } = {}) => {
      if (!connected || !address || disabled) return;
      if (authInFlightRef.current) return;
      if (!force && attemptedAddressRef.current === address) return;

      if (typeof signMessage !== "function") {
        showToast?.(t("wallet.signUnsupported"), "danger");
        return;
      }

      authInFlightRef.current = true;
      attemptedAddressRef.current = address;
      setAuthenticating(true);

      try {
        const challengeRes = await fetch(
          withBase("/api/v1/auth/solana/challenge"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              public_key: address,
              language: i18n.language || "en",
            }),
          },
        );

        const challengeData = await challengeRes.json().catch(() => ({}));

        if (!challengeRes.ok) {
          throw new Error(
            challengeData?.detail ||
              challengeData?.error ||
              "walletChallengeFailed",
          );
        }

        const message = challengeData?.message;
        if (!message || typeof message !== "string") {
          throw new Error("walletChallengeFailed");
        }

        const encodedMessage = new TextEncoder().encode(message);
        const signatureBytes = await signMessage(encodedMessage);

        const verifyRes = await fetch(withBase("/api/v1/auth/solana/verify"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public_key: address,
            message,
            signature: bytesToBase64(signatureBytes),
            signature_encoding: "base64",
            remember_me: true,
            language: i18n.language || "en",
          }),
        });

        const verifyData = await verifyRes.json().catch(() => ({}));

        if (!verifyRes.ok) {
          throw new Error(
            verifyData?.detail || verifyData?.error || "walletAuthFailed",
          );
        }

        if (verifyData?.access_token) {
          onLogin?.(verifyData);
          showToast?.(t("wallet.loginSuccess"), "success");
          return;
        }

        if (verifyData?.status === "pending_confirmation") {
          showToast?.(t("wallet.pendingApproval"), "secondary");
          return;
        }

        throw new Error("walletAuthFailed");
      } catch (err) {
        resetAttempt();
        showToast?.(
          t(normalizeErrorMessage(err, "walletAuthFailed")),
          "danger",
        );
      } finally {
        authInFlightRef.current = false;
        setAuthenticating(false);
      }
    },
    [
      address,
      connected,
      disabled,
      i18n.language,
      onLogin,
      resetAttempt,
      showToast,
      signMessage,
      t,
    ],
  );

  useEffect(() => {
    if (!connected || !address || disabled) return;
    authenticateWallet();
  }, [connected, address, disabled, authenticateWallet]);

  const handleConnectClick = () => {
    if (disabled || connecting || authenticating || autoConnecting) return;

    resetAttempt();
    manualConnectRequestedRef.current = true;

    if (wallet && !connected) {
      setConnectRequestId((n) => n + 1);
      return;
    }

    if (hasBrowserWalletFlow) {
      setConnectRequestId((n) => n + 1);
      setVisible(true);
      return;
    }

    if (availableWalletNames.has("Phantom")) {
      try {
        select("Phantom");
        setConnectRequestId((n) => n + 1);
      } catch (err) {
        showToast?.(
          t(normalizeErrorMessage(err, "wallet.connectionFailed")),
          "danger",
        );
      }
      return;
    }

    if (availableWalletNames.has("Solflare")) {
      try {
        select("Solflare");
        setConnectRequestId((n) => n + 1);
      } catch (err) {
        showToast?.(
          t(normalizeErrorMessage(err, "wallet.connectionFailed")),
          "danger",
        );
      }
      return;
    }

    showToast?.(t("wallet.notAvailable"), "danger");
  };

  const handleFallbackWalletConnect = (preferredWalletName) => {
    if (
      disabled ||
      connecting ||
      authenticating ||
      autoConnecting ||
      !preferredWalletName
    ) {
      return;
    }

    if (!availableWalletNames.has(preferredWalletName)) {
      showToast?.(t("wallet.notAvailable"), "danger");
      return;
    }

    resetAttempt();
    manualConnectRequestedRef.current = true;

    try {
      select(preferredWalletName);
      setConnectRequestId((n) => n + 1);
    } catch (err) {
      showToast?.(
        t(normalizeErrorMessage(err, "wallet.connectionFailed")),
        "danger",
      );
    }
  };

  const handleConnectedButtonClick = async () => {
    if (disabled || connecting || authenticating || autoConnecting) return;

    if (isWalletButtonHovered) {
      try {
        manualConnectRequestedRef.current = false;
        localStorage.removeItem(LAST_WALLET_KEY);
        resetAttempt();
        setIsWalletButtonHovered(false);
        await disconnect();
      } catch (err) {
        showToast?.(
          t(normalizeErrorMessage(err, "wallet.disconnectError")),
          "danger",
        );
      }
      return;
    }

    resetAttempt();
    authenticateWallet({ force: true });
  };

  const busy = connecting || authenticating || autoConnecting;

  const connectedButtonLabel = authenticating
    ? t("wallet.signingIn", {
        wallet: walletName,
        address: truncateKey(address, 6, 6),
      })
    : isWalletButtonHovered
      ? t("wallet.disconnectWallet")
      : t("wallet.connectedLabel", {
          wallet: walletName,
          address: truncateKey(address, 6, 6),
        });

  return (
    <div className="Auth-oauth-wallets">
      {!connected ? (
        <>
          <Button
            className="Auth-oauth-button"
            variant="outline-secondary"
            size="md"
            onClick={handleConnectClick}
            disabled={disabled || busy}
          >
            <img
              src="/icons/solana.png"
              alt={t("wallet.solanaDefaultName")}
              className="Auth-oauth-logo"
            />
            {busy ? t("wallet.connecting") : t("wallet.connectSolanaWallet")}
          </Button>

          {!hasBrowserWalletFlow && availableWalletNames.has("Phantom") && (
            <Button
              className="Auth-oauth-button"
              variant="outline-secondary"
              size="md"
              onClick={() => handleFallbackWalletConnect("Phantom")}
              disabled={disabled || busy}
            >
              <img
                src="/icons/phantom.png"
                alt="Phantom"
                className="Auth-oauth-logo"
              />
              {t("wallet.connectWithPhantom")}
            </Button>
          )}

          {!hasBrowserWalletFlow && availableWalletNames.has("Solflare") && (
            <Button
              className="Auth-oauth-button"
              variant="outline-secondary"
              size="md"
              onClick={() => handleFallbackWalletConnect("Solflare")}
              disabled={disabled || busy}
            >
              <img
                src="/icons/solflare.png"
                alt="Solflare"
                className="Auth-oauth-logo"
              />
              {t("wallet.connectWithSolflare")}
            </Button>
          )}
        </>
      ) : (
        <Button
          className="Auth-oauth-button"
          variant="outline-secondary"
          size="md"
          onClick={handleConnectedButtonClick}
          onMouseEnter={() => setIsWalletButtonHovered(true)}
          onMouseLeave={() => setIsWalletButtonHovered(false)}
          disabled={disabled || authenticating || autoConnecting}
        >
          <img
            src={currentWalletIcon}
            alt={walletName}
            className="Auth-oauth-logo"
          />
          {connectedButtonLabel}
        </Button>
      )}
    </div>
  );
}

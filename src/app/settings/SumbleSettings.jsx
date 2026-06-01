import React, { useState, useEffect } from "react";
import {
  Text,
  Heading,
  Flex,
  Divider,
  Input,
  Button,
  LoadingButton,
  Link,
  Alert,
  StatusTag,
  LoadingSpinner,
  hubspot,
} from "@hubspot/ui-extensions";

hubspot.extend(({ context }) => <SumbleSettings context={context} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";

const SumbleSettings = ({ context }) => {
  const portalId = context?.portal?.id;

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [msg, setMsg] = useState(null); // { type, text }

  const call = async (path, options) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, options);
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Request failed");
    return json;
  };

  const loadStatus = async () => {
    setLoading(true);
    try {
      const json = await call(`/api/sumble-connection?portalId=${encodeURIComponent(portalId || "")}`, { method: "GET" });
      setStatus(json);
    } catch (err) {
      setMsg({ type: "error", text: err.message || "Couldn't load connection status." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const connect = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await call("/api/sumble-connection", { method: "POST", body: { portalId, apiKey: apiKey.trim() } });
      setApiKey("");
      setMsg({ type: "success", text: "Sumble connected. All Sumble cards in this account now use this key." });
      await loadStatus();
    } catch (err) {
      setMsg({ type: "error", text: err.message || "Couldn't connect." });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setMsg(null);
    try {
      await call("/api/sumble-connection", { method: "DELETE", body: { portalId } });
      setMsg({ type: "success", text: "Disconnected. Stored key removed." });
      await loadStatus();
    } catch (err) {
      setMsg({ type: "error", text: err.message || "Couldn't disconnect." });
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center"><LoadingSpinner label="Loading connection status..." /></Flex>
    );
  }

  const connected = status?.connected;
  const source = status?.source;

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Connect Sumble</Heading>
        <Text variant="microcopy">
          Connect your team's Sumble account once here. Every rep using the Sumble cards in this
          HubSpot account shares this connection — no per-user setup. The key is validated with
          Sumble and stored encrypted on the backend; it's never shown again.
        </Text>
      </Flex>

      {/* Current status */}
      <Flex direction="row" gap="small" align="center" wrap="wrap">
        {connected && source === "stored" ? (
          <StatusTag variant="success">Connected</StatusTag>
        ) : connected && source === "env" ? (
          <StatusTag variant="info">Using backend fallback key</StatusTag>
        ) : (
          <StatusTag variant="danger">Not connected</StatusTag>
        )}
        {status?.masked ? <Text variant="microcopy">Key: {status.masked}</Text> : null}
        {status?.updatedAt ? <Text variant="microcopy">· updated {new Date(status.updatedAt).toLocaleDateString()}</Text> : null}
      </Flex>

      {source === "env" ? (
        <Text variant="microcopy">
          A fallback key is set on the backend. Save a key here to manage the connection in-app instead.
        </Text>
      ) : null}

      {status && status.encryption === false ? (
        <Alert title="Encryption not configured" variant="warning">
          The backend's <Text inline format={{ fontWeight: "bold" }}>ENCRYPTION_KEY</Text> isn't set, so a key can't be stored securely yet. Set it on the Render service, then connect.
        </Alert>
      ) : null}

      {msg ? <Alert title={msg.type === "success" ? "Done" : "Error"} variant={msg.type === "success" ? "success" : "error"}>{msg.text}</Alert> : null}

      <Divider />

      {/* Connect / update */}
      <Flex direction="column" gap="small">
        <Input
          label={connected ? "Replace Sumble API key" : "Sumble API key"}
          name="apiKey"
          value={apiKey}
          onInput={(v) => setApiKey(v)}
          placeholder="Paste your Sumble API key"
        />
        <Text variant="microcopy">
          Generate one at <Link href={{ url: "https://sumble.com/account/api-keys", external: true }}>sumble.com/account/api-keys</Link> (shown once). Requires admin access to this app.
        </Text>
        <Flex direction="row" gap="small" align="center">
          <LoadingButton
            loading={saving}
            disabled={!apiKey.trim() || saving}
            onClick={connect}
            variant="primary"
          >
            {connected && source === "stored" ? "Test & replace key" : "Test & connect"}
          </LoadingButton>
          {connected && source === "stored" ? (
            <LoadingButton loading={disconnecting} onClick={disconnect} variant="destructive">
              Disconnect
            </LoadingButton>
          ) : null}
        </Flex>
      </Flex>
    </Flex>
  );
};

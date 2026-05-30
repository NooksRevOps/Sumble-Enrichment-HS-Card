import React, { useState, useEffect, useRef } from "react";
import {
  Text,
  Heading,
  Flex,
  Box,
  Divider,
  Link,
  Button,
  LoadingButton,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleBriefCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const MAX_POLLS = 8;

// --- minimal markdown -> UI-extension components renderer ---
// Handles headings (#/##/###), bullets (-/*), and inline **bold**. Good enough
// for Sumble's brief (What's the Angle / Who to Contact First / The Intel / ...).
const renderInline = (line, keyBase) => {
  const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== "");
  return parts.map((seg, i) => {
    const m = seg.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      return (
        <Text key={`${keyBase}-${i}`} inline format={{ fontWeight: "bold" }}>{m[1]}</Text>
      );
    }
    return <Text key={`${keyBase}-${i}`} inline>{seg}</Text>;
  });
};

const renderMarkdown = (md) => {
  if (!md) return null;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push(<Box key={`sp-${idx}`} />); // spacer
      return;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      out.push(<Heading key={`h-${idx}`} inline>{h[2].replace(/\*\*/g, "")}</Heading>);
      return;
    }
    const b = line.match(/^[-*•]\s+(.*)$/);
    if (b) {
      out.push(
        <Flex key={`b-${idx}`} direction="row" gap="extra-small">
          <Text>•</Text>
          <Text>{renderInline(b[1], `b-${idx}`)}</Text>
        </Flex>
      );
      return;
    }
    // ALL-CAPS short line → treat as a section heading (Sumble uses these)
    if (line.length < 40 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
      out.push(<Heading key={`hc-${idx}`} inline>{line.replace(/\*\*/g, "")}</Heading>);
      return;
    }
    out.push(<Text key={`p-${idx}`}>{renderInline(line, `p-${idx}`)}</Text>);
  });
  return out;
};

const SumbleBriefCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const pollRef = useRef(0);

  const callBackend = async (path) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "brief" },
    });
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Backend error");
    return json;
  };

  const load = async (path) => {
    const json = await callBackend(path);
    setData(json);
    // If Sumble is still generating, poll (pending retries are free).
    if (json.briefStatus === "pending" && pollRef.current < MAX_POLLS) {
      pollRef.current += 1;
      const wait = (json.briefRetryAfter || 20) * 1000;
      setTimeout(() => load("/api/enrichment"), wait);
    }
    return json;
  };

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        pollRef.current = 0;
        await load("/api/enrichment");
      } catch (err) {
        console.error("[SumbleBrief] load error:", err);
        setError(err.message || "Couldn't load the brief.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const regenerate = async () => {
    try {
      setRefreshing(true);
      pollRef.current = 0;
      await load("/api/refresh");
    } catch (err) {
      setError(err.message || "Regenerate failed.");
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Loading Sumble intelligence brief..." />
      </Flex>
    );
  }
  if (error) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load the brief" variant="error">{error}</Alert>
        <Button onClick={regenerate} variant="secondary">Try again</Button>
      </Flex>
    );
  }

  if (data?.briefError) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Brief unavailable" variant="warning">{data.briefError}</Alert>
        {data.briefSumbleUrl ? (
          <Link href={{ url: data.briefSumbleUrl, external: true }}>Open this account in Sumble ↗</Link>
        ) : null}
      </Flex>
    );
  }

  if (data?.briefStatus === "pending") {
    return (
      <Flex direction="column" align="center" gap="small">
        <LoadingSpinner label="Sumble is generating this brief…" />
        <Text variant="microcopy">This usually takes 20–40 seconds. It'll appear automatically.</Text>
      </Flex>
    );
  }

  const brief = data?.brief;
  if (!brief) {
    return (
      <EmptyState title="No brief yet" imageName="announcement" layout="vertical">
        <Text>No intelligence brief is available for this account yet.</Text>
        <Button onClick={regenerate} variant="primary">Generate brief (uses ~50 Sumble credits)</Button>
      </EmptyState>
    );
  }

  return (
    <Flex direction="column" gap="small">
      {renderMarkdown(brief)}
      <Divider />
      <Flex direction="row" gap="small" justify="between" align="center" wrap="wrap">
        {data?.briefSumbleUrl ? (
          <Link href={{ url: data.briefSumbleUrl, external: true }}>Open in Sumble ↗</Link>
        ) : <Text variant="microcopy"> </Text>}
        <LoadingButton loading={refreshing} onClick={regenerate} variant="secondary" size="xs">
          Regenerate (uses ~50 credits)
        </LoadingButton>
      </Flex>
      <Text variant="microcopy">Briefs are cached for 7 days, so repeat views don't spend credits.</Text>
    </Flex>
  );
};

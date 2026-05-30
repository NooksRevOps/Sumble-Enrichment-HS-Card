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

// "Generated 3 days ago" style relative time from an ISO timestamp.
const timeAgo = (iso) => {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
};

// --- minimal markdown -> UI-extension components renderer ---
// Handles inline [text](url) links and **bold** within a line.
const renderInline = (line, keyBase) => {
  const tokenRe = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g;
  const parts = line.split(tokenRe).filter((s) => s !== "");
  return parts.map((seg, i) => {
    const link = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return (
        <Link key={`${keyBase}-${i}`} href={{ url: link[2], external: true }}>{link[1]}</Link>
      );
    }
    const bold = seg.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      return <Text key={`${keyBase}-${i}`} inline format={{ fontWeight: "bold" }}>{bold[1]}</Text>;
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
      out.push(<Box key={`sp-${idx}`} />);
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

  const [loading, setLoading] = useState(true);     // initial cached-only load
  const [generating, setGenerating] = useState(false); // deliberate paid generate/regenerate
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const pollRef = useRef(0);

  // cachedOnly=true → never spends credits. cachedOnly=false → deliberate generate.
  const callBackend = async (path, cachedOnly) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "brief", cachedOnly },
    });
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Backend error");
    return json;
  };

  // Once generation has begun, keep polling with cachedOnly:false (pending = free).
  const load = async (path, cachedOnly) => {
    const json = await callBackend(path, cachedOnly);
    setData(json);
    if (json.briefStatus === "pending" && pollRef.current < MAX_POLLS) {
      pollRef.current += 1;
      const wait = (json.briefRetryAfter || 20) * 1000;
      setTimeout(() => load("/api/enrichment", false), wait);
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
        await load("/api/enrichment", true); // cached-only — no credits on open
      } catch (err) {
        console.error("[SumbleBrief] load error:", err);
        setError(err.message || "Couldn't load the brief.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const generate = async (path) => {
    try {
      setGenerating(true);
      setError(null);
      pollRef.current = 0;
      await load(path, false); // deliberate paid call
    } catch (err) {
      setError(err.message || "Generate failed.");
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Checking for a cached brief..." />
      </Flex>
    );
  }
  if (error) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load the brief" variant="error">{error}</Alert>
        <Button onClick={() => generate("/api/enrichment")} variant="secondary">Try again</Button>
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

  // Generating (after a deliberate click) → polling.
  if (data?.briefStatus === "pending") {
    return (
      <Flex direction="column" align="center" gap="small">
        <LoadingSpinner label="Sumble is generating this brief…" />
        <Text variant="microcopy">This usually takes 20–40 seconds. It'll appear automatically.</Text>
      </Flex>
    );
  }

  // Gated: nothing cached, no paid call made on open. Rep clicks to generate.
  if (data?.briefStatus === "not_loaded" || !data?.brief) {
    return (
      <EmptyState title="Generate the Sumble intelligence brief" imageName="announcement" layout="vertical">
        <Text>
          Sumble writes an AI brief for this account — the angle, who to contact first, and the intel.
          Generating one uses ~50 Sumble credits and is then cached for 7 days.
        </Text>
        <LoadingButton loading={generating} onClick={() => generate("/api/enrichment")} variant="primary">
          Generate brief (uses ~50 credits)
        </LoadingButton>
      </EmptyState>
    );
  }

  const age = timeAgo(data?.briefCachedAt);
  return (
    <Flex direction="column" gap="small">
      {renderMarkdown(data.brief)}
      <Divider />
      <Flex direction="row" gap="small" justify="between" align="center" wrap="wrap">
        {data?.briefSumbleUrl ? (
          <Link href={{ url: data.briefSumbleUrl, external: true }}>Open in Sumble ↗</Link>
        ) : <Text variant="microcopy"> </Text>}
        <Flex direction="row" gap="small" align="center">
          {age ? <Text variant="microcopy">Generated {age}</Text> : null}
          <LoadingButton loading={generating} onClick={() => generate("/api/refresh")} variant="secondary" size="xs">
            Refresh (uses ~50 credits)
          </LoadingButton>
        </Flex>
      </Flex>
      <Text variant="microcopy">This brief is cached until you refresh it, so repeat views don't spend credits.</Text>
    </Flex>
  );
};

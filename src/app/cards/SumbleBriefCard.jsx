import React, { useState, useEffect, useRef } from "react";
import {
  Text,
  Heading,
  Flex,
  Box,
  Tile,
  Divider,
  Link,
  Button,
  LoadingButton,
  StatusTag,
  Alert,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumbleBriefCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";
const MAX_POLLS = 8;

const ext = (url) => {
  if (!url) return null;
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return { url: full, external: true };
};

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
// Render a run of text, extracting any inline [text](url) links. `bold` makes
// the non-link text bold (links can't carry bold, so they render as plain Links).
const renderTextRun = (str, keyBase, bold) => {
  const fmt = bold ? { fontWeight: "bold" } : undefined;
  const nodes = [];
  let last = 0;
  let i = 0;
  for (const m of str.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    if (m.index > last) {
      nodes.push(<Text key={`${keyBase}-t${i}`} inline format={fmt}>{str.slice(last, m.index)}</Text>);
    }
    nodes.push(<Link key={`${keyBase}-l${i}`} href={ext(m[2])}>{m[1]}</Link>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < str.length) {
    nodes.push(<Text key={`${keyBase}-t${i}`} inline format={fmt}>{str.slice(last)}</Text>);
  }
  return nodes;
};

// Render a line: split out **bold** runs, and extract links inside both the
// bold runs and the surrounding text (Sumble puts links inside bold headers).
const renderInline = (line, keyBase) => {
  const out = [];
  let last = 0;
  let i = 0;
  for (const m of line.matchAll(/\*\*([^*]+)\*\*/g)) {
    if (m.index > last) out.push(...renderTextRun(line.slice(last, m.index), `${keyBase}-n${i}`, false));
    out.push(...renderTextRun(m[1], `${keyBase}-b${i}`, true));
    last = m.index + m[0].length;
    i++;
  }
  if (last < line.length) out.push(...renderTextRun(line.slice(last), `${keyBase}-n${i}`, false));
  return out;
};

const renderMarkdown = (md) => {
  if (!md) return null;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (!line.trim()) { out.push(<Box key={`sp-${idx}`} />); return; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push(<Heading key={`h-${idx}`} inline>{h[2].replace(/\*\*/g, "")}</Heading>); return; }
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
  const portalId = context?.portal?.id;

  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const pollRef = useRef(0);

  const callBackend = async (path, cachedOnly) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "brief", cachedOnly, portalId },
    });
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Backend error");
    return json;
  };

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
      await load(path, false);
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
        {ext(data.briefSumbleUrl) ? (
          <Link href={ext(data.briefSumbleUrl)}>Open this account in Sumble</Link>
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

  // Gated: nothing cached, no paid call on open. Clean tile (no cartoon image).
  if (data?.briefStatus === "not_loaded" || !data?.brief) {
    return (
      <Tile>
        <Flex direction="column" gap="small">
          <Heading inline>Sumble Intelligence Brief</Heading>
          <Text variant="microcopy">
            Sumble writes an AI account brief — the angle, who to contact first, the intel, and recent
            changes. Generating one uses ~50 Sumble credits, then it's cached until you refresh it.
          </Text>
          <LoadingButton loading={generating} onClick={() => generate("/api/enrichment")} variant="primary">
            Generate brief · ~50 credits
          </LoadingButton>
        </Flex>
      </Tile>
    );
  }

  const age = timeAgo(data?.briefCachedAt);
  return (
    <Flex direction="column" gap="small">
      {/* Top control bar: age + actions, before the brief text */}
      <Flex direction="row" justify="between" align="center" gap="small" wrap="wrap">
        {age ? <StatusTag variant="default">Generated {age}</StatusTag> : <Box />}
        <Flex direction="row" gap="small" align="center">
          {ext(data?.briefSumbleUrl) ? <Link href={ext(data.briefSumbleUrl)}>Open in Sumble</Link> : null}
          <LoadingButton loading={generating} onClick={() => generate("/api/refresh")} variant="secondary" size="xs">
            Refresh · ~50 credits
          </LoadingButton>
        </Flex>
      </Flex>
      <Divider />
      {renderMarkdown(data.brief)}
    </Flex>
  );
};

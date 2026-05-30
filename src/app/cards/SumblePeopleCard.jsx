import React, { useState, useEffect } from "react";
import {
  Text,
  Heading,
  Flex,
  Divider,
  Statistics,
  StatisticsItem,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
  Link,
  Button,
  LoadingButton,
  Alert,
  EmptyState,
  LoadingSpinner,
  hubspot,
  useExtensionContext,
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions }) => <SumblePeopleCard actions={actions} />);

const BACKEND_URL = "https://sumble-enrichment-backend.onrender.com";

const intOrDash = (v) =>
  v === null || v === undefined || v === "" ? "—" : Math.round(Number(v)).toLocaleString();

const SumblePeopleCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;

  const [loading, setLoading] = useState(true);   // initial cached-only load
  const [fetching, setFetching] = useState(false); // explicit paid fetch / refresh
  const [error, setError] = useState(null);
  const [syncedCount, setSyncedCount] = useState(null);
  const [data, setData] = useState(null);

  // cachedOnly=true → no credits. cachedOnly=false → deliberate paid fetch.
  const callBackend = async (path, cachedOnly) => {
    const resp = await hubspot.fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      body: { companyId, want: "people", cachedOnly },
    });
    const json = await resp.json();
    if (json.status !== "success") throw new Error(json.message || "Backend error");
    return json;
  };

  useEffect(() => {
    (async () => {
      if (!companyId) return;
      try {
        setLoading(true);
        setError(null);
        const props = await actions.fetchCrmObjectProperties(["sumble_sdr_ic_people_count"]);
        setSyncedCount(props.sumble_sdr_ic_people_count || null);
        // cached-only: shows people if already cached, else a "not_loaded" status. No credits.
        const json = await callBackend("/api/enrichment", true);
        setData(json);
      } catch (err) {
        console.error("[SumblePeople] load error:", err);
        setError(err.message || "Couldn't load SDR people.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const fetchLive = async (path, cachedOnly) => {
    try {
      setFetching(true);
      setError(null);
      const json = await callBackend(path, cachedOnly);
      setData(json);
    } catch (err) {
      setError(err.message || "Fetch failed.");
    } finally {
      setFetching(false);
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center">
        <LoadingSpinner label="Loading SDR people..." />
      </Flex>
    );
  }
  if (error) {
    return (
      <Flex direction="column" gap="small">
        <Alert title="Couldn't load SDR people" variant="error">{error}</Alert>
        <Button onClick={() => fetchLive("/api/enrichment", false)} variant="secondary">Try again</Button>
      </Flex>
    );
  }

  const liveCount = data?.sdrLiveCount;
  const people = data?.sdrPeople || [];
  const status = data?.peopleStatus;
  const notLoaded = status === "not_loaded";
  const hasLeadScore = people.some((p) => p.leadScore !== null && p.leadScore !== undefined);
  const mismatch =
    syncedCount != null && liveCount != null && Number(syncedCount) !== Number(liveCount);

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading inline>IC SDRs at this account</Heading>
        <Text variant="microcopy">
          Sumble's IC-SDR estimate is Nooks' sellable-seat signal. The synced count is free;
          pull the named people from Sumble to verify it (uses ~1 credit per person, cached 24h).
        </Text>
      </Flex>

      <Statistics>
        <StatisticsItem label="Synced count (HubSpot)" number={intOrDash(syncedCount)} />
        {!notLoaded ? (
          <StatisticsItem label="Live count (Sumble)" number={intOrDash(liveCount)} />
        ) : null}
      </Statistics>

      {data?.peopleError ? (
        <Alert title="Sumble lookup unavailable" variant="warning">{data.peopleError}</Alert>
      ) : null}

      {/* Gated: no paid call happened on load. Rep clicks to fetch. */}
      {notLoaded && !data?.peopleError ? (
        <EmptyState title="Verify SDR headcount with Sumble" imageName="contacts" layout="vertical">
          <Text>
            Pull the named IC-SDR people from Sumble to cross-check the synced count of{" "}
            <Text inline format={{ fontWeight: "bold" }}>{intOrDash(syncedCount)}</Text>.
          </Text>
          <LoadingButton
            loading={fetching}
            onClick={() => fetchLive("/api/enrichment", false)}
            variant="primary"
          >
            Load SDR people from Sumble (uses credits)
          </LoadingButton>
        </EmptyState>
      ) : null}

      {mismatch ? (
        <Alert title="Counts differ" variant="warning">
          The synced HubSpot count ({intOrDash(syncedCount)}) doesn't match Sumble's live count
          ({intOrDash(liveCount)}). Worth confirming RevOps' seat sizing for this account.
        </Alert>
      ) : null}

      {!notLoaded && people.length === 0 && !data?.peopleError ? (
        <EmptyState title="No SDR-role people found" imageName="contacts" layout="vertical">
          <Text>Sumble didn't return any people matching the SDR filter for this account.</Text>
        </EmptyState>
      ) : null}

      {people.length > 0 ? (
        <Table bordered={true} density="condensed">
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Title</TableHeader>
              <TableHeader>Level</TableHeader>
              <TableHeader>Location</TableHeader>
              {hasLeadScore ? <TableHeader align="right">Lead Score</TableHeader> : null}
            </TableRow>
          </TableHead>
          <TableBody>
            {people.map((person, i) => (
              <TableRow key={person.id || i}>
                <TableCell>
                  {person.linkedinUrl ? (
                    <Link href={{ url: person.linkedinUrl, external: true }}>{person.name || "—"}</Link>
                  ) : (
                    person.name || "—"
                  )}
                </TableCell>
                <TableCell>{person.title || "—"}</TableCell>
                <TableCell>{person.jobLevel || "—"}</TableCell>
                <TableCell>{person.location || "—"}</TableCell>
                {hasLeadScore ? (
                  <TableCell align="right">
                    {person.leadScore !== null && person.leadScore !== undefined ? person.leadScore : "—"}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <Divider />
      <Flex direction="row" gap="small" justify="between" align="center" wrap="wrap">
        {data?.sdrDeepLinkUrl ? (
          <Link href={{ url: data.sdrDeepLinkUrl, external: true }}>View all SDRs in Sumble ↗</Link>
        ) : <Text variant="microcopy"> </Text>}
        {!notLoaded ? (
          <LoadingButton
            loading={fetching}
            onClick={() => fetchLive("/api/refresh", false)}
            variant="secondary"
            size="xs"
          >
            Refresh from Sumble (uses credits)
          </LoadingButton>
        ) : null}
      </Flex>
    </Flex>
  );
};

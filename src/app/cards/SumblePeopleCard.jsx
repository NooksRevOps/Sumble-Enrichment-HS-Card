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

// Tenure in current role from a start date.
const tenure = (startDate) => {
  if (!startDate) return "—";
  const d = new Date(startDate);
  if (Number.isNaN(d.getTime())) return "—";
  const months = Math.max(0, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.4)));
  if (months < 12) return `${months} mo`;
  const yrs = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${yrs}y ${rem}m` : `${yrs} yr`;
};

const SumblePeopleCard = ({ actions }) => {
  const context = useExtensionContext();
  const companyId = context?.crm?.objectId;

  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [syncedCount, setSyncedCount] = useState(null);
  const [data, setData] = useState(null);

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
        setData(await callBackend("/api/enrichment", true)); // cached-only, free
      } catch (err) {
        console.error("[SumblePeople] load error:", err);
        setError(err.message || "Couldn't load SDR people.");
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const fetchLive = async (path) => {
    try {
      setFetching(true);
      setError(null);
      setData(await callBackend(path, false));
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
        <Button onClick={() => fetchLive("/api/enrichment")} variant="secondary">Try again</Button>
      </Flex>
    );
  }

  const liveCount = data?.sdrLiveCount;
  const people = data?.sdrPeople || [];
  const notLoaded = data?.peopleStatus === "not_loaded";
  const hasLeadScore = people.some((x) => x.leadScore !== null && x.leadScore !== undefined);
  const mismatch = syncedCount != null && liveCount != null && Number(syncedCount) !== Number(liveCount);

  return (
    <Flex direction="column" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading inline>IC SDR seats</Heading>
        <Text variant="microcopy">
          Cross-check the IC-SDR count Nooks sells against. Load the named people from Sumble
          (≈1 credit each, cached 30 days) to confirm the number is real.
        </Text>
      </Flex>

      <Statistics>
        <StatisticsItem label="Synced (HubSpot)" number={intOrDash(syncedCount)} />
        {!notLoaded ? <StatisticsItem label="Live (Sumble)" number={intOrDash(liveCount)} /> : null}
      </Statistics>

      {mismatch ? (
        <Alert title="Counts differ" variant="warning">
          Synced ({intOrDash(syncedCount)}) ≠ Sumble live ({intOrDash(liveCount)}). Worth confirming
          RevOps' seat sizing for this account.
        </Alert>
      ) : null}

      {data?.peopleError ? (
        <Alert title="Sumble lookup unavailable" variant="warning">{data.peopleError}</Alert>
      ) : null}

      {notLoaded && !data?.peopleError ? (
        <EmptyState title="Confirm the seat count" imageName="contacts" layout="vertical">
          <Text>Pull the top IC-SDR people from Sumble to verify the synced figure.</Text>
          <LoadingButton loading={fetching} onClick={() => fetchLive("/api/enrichment")} variant="primary">
            Load SDR people (uses credits)
          </LoadingButton>
        </EmptyState>
      ) : null}

      {!notLoaded && people.length === 0 && !data?.peopleError ? (
        <EmptyState title="No SDR-role people found" imageName="contacts" layout="vertical">
          <Text>Sumble returned no people matching the SDR filter for this account.</Text>
        </EmptyState>
      ) : null}

      {people.length > 0 ? (
        <Table bordered={true} density="condensed">
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>Title</TableHeader>
              <TableHeader>Level</TableHeader>
              <TableHeader>Tenure</TableHeader>
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
                  ) : (person.name || "—")}
                </TableCell>
                <TableCell>{person.title || "—"}</TableCell>
                <TableCell>{person.jobLevel || "—"}</TableCell>
                <TableCell>{tenure(person.startDate)}</TableCell>
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

      {!notLoaded ? (
        <>
          <Divider />
          <Flex direction="row" gap="small" justify="between" align="center" wrap="wrap">
            {data?.sdrDeepLinkUrl ? (
              <Link href={{ url: data.sdrDeepLinkUrl, external: true }}>View all SDRs in Sumble</Link>
            ) : <Text variant="microcopy"> </Text>}
            <LoadingButton loading={fetching} onClick={() => fetchLive("/api/refresh")} variant="secondary" size="xs">
              Refresh (uses credits)
            </LoadingButton>
          </Flex>
        </>
      ) : null}
    </Flex>
  );
};

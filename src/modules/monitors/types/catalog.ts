import { isScheduledKind } from "./contract";
import type { CheckTypeDescriptor, CheckTypeKind } from "./contract";

/**
 * Isomorphic metadata for every check type.
 *
 * This module is imported by the monitor form (a client component), so
 * it must stay free of zod and of every `node:` import. That constraint
 * is the whole reason descriptors are separated from definitions: the
 * probe implementations pull in `node:dns`, `node:net`, `node:tls` and
 * `node:child_process`, none of which may reach the browser bundle.
 *
 * Adding a type means a descriptor here, a spec in `specs/<id>.ts`, a
 * probe in `probes/<id>.ts`, an entry in `specs/index.ts` and one in
 * `registry.ts` — five files. The conformance suite fails if any of them
 * disagree; forgetting `specs/index.ts` in particular produces a type
 * that renders in the form selector and then fails validation with
 * "Unknown check type".
 */

const RESPONSE_TIME = {
  key: "responseTimeMs",
  label: "Response time",
  kind: "number",
  unit: "ms",
} as const;

export const DEFAULT_MYSQL_PORT = 3306;
export const DEFAULT_REDIS_PORT = 6379;
export const DEFAULT_SMTP_PORT = 25;
export const DEFAULT_MQTT_PORT = 1883;
export const DEFAULT_MONGODB_PORT = 27017;
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

export const httpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "http",
  label: "HTTP(S) request",
  description: "Fetch a URL and assert on the status code, body and TLS.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "https://example.com/health",
    help: "The full URL to request, including the scheme.",
  },
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    RESPONSE_TIME,
    { key: "keywordPresent", label: "Keyword found", kind: "boolean" },
    {
      key: "tlsDaysRemaining",
      label: "Certificate expires in",
      kind: "number",
      unit: "days",
    },
  ],
  form: ["method", "expectedStatusCode", "keyword", "tlsWarning"],
  supportsRecovery: true,
};

export const tcpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "tcp",
  label: "TCP port",
  description: "Open a TCP connection to a host and port.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "db.example.com",
    help: "A bare hostname, no scheme, no port.",
  },
  port: { required: true, default: null },
  facts: [RESPONSE_TIME],
  form: ["port"],
  supportsRecovery: true,
};

export const pingDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ping",
  label: "Ping (ICMP)",
  description: "Send an ICMP echo and measure the round trip.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "gateway.example.com",
    help: "A bare hostname. ICMP has no ports.",
  },
  port: null,
  facts: [
    { key: "responseTimeMs", label: "Round trip", kind: "number", unit: "ms" },
    { key: "packetsReceived", label: "Replies", kind: "number" },
  ],
  form: [],
  configFields: [
    {
      name: "packets",
      emptyValue: "omit",
      label: "Echo requests",
      control: { kind: "number", min: 1, max: 5, unit: "packets" },
      help: "How many ICMP echoes one check sends. One reply is enough to pass, so raising this rides out a link that drops the occasional packet; at 1, a single lost echo (or a host that rate-limits ICMP) is a full outage in the timeline.",
      group: "advanced",
    },
  ],
  // ICMP needs a raw socket. On Linux that is CAP_NET_RAW, or a
  // `net.ipv4.ping_group_range` that includes the worker's gid. When it
  // is absent the monitor reads `misconfigured`, never `down`.
  requiresCapability: "icmp",
  supportsRecovery: false,
};

/** Record types a `dns` monitor can ask for. Lives in the catalog so the
 * form can render the selector without importing zod. */
export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "TXT",
] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const dnsDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "dns",
  label: "DNS record",
  description: "Resolve a name and assert on the records that come back.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "example.com",
    help: "The name to resolve.",
  },
  port: null,
  facts: [
    { key: "records", label: "Records", kind: "list" },
    { key: "recordCount", label: "Record count", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Resolve time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["dnsRecord"],
  supportsRecovery: false,
};

export const tlsExpiryDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "tls-expiry",
  label: "TLS certificate expiry",
  description: "Watch how long a certificate has left before it expires.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "example.com",
    help: "The host to handshake with. Defaults to port 443.",
  },
  port: { required: false, default: 443 },
  facts: [
    {
      key: "daysRemaining",
      label: "Expires in",
      kind: "number",
      unit: "days",
    },
    { key: "issuer", label: "Issuer", kind: "string" },
    { key: "validTo", label: "Valid until", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port", "expiryWarning"],
  supportsRecovery: false,
};

export const domainExpiryDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "domain-expiry",
  label: "Domain expiry",
  description: "Watch a domain registration's expiry date over RDAP.",
  target: {
    kind: "domain",
    label: "Domain",
    placeholder: "example.com",
    help: "The registrable domain, no scheme, no subdomain.",
  },
  port: null,
  facts: [
    {
      key: "daysRemaining",
      label: "Expires in",
      kind: "number",
      unit: "days",
    },
    { key: "expiresAt", label: "Registered until", kind: "string" },
    { key: "registrar", label: "Registrar", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["expiryWarning"],
  supportsRecovery: false,
};

function unknownDescriptor(id: string): CheckTypeDescriptor {
  return {
    id,
    // `active` is the honest guess and the safe one. The scheduler keeps
    // enqueuing a monitor whose type this build lost, `performCheck`
    // answers `indeterminate`, and the row reads "not available in this
    // build" every interval. Guessing `manual` would instead take it off
    // the schedule entirely and leave it sitting on its last known
    // status, which is a monitor that has quietly stopped monitoring.
    kind: "active",
    label: id,
    description: "This check type is not available in this build.",
    target: { kind: "hostname", label: "Target", placeholder: "", help: "" },
    port: null,
    facts: [],
    form: [],
    supportsRecovery: false,
  };
}

export const postgresDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "postgres",
  label: "PostgreSQL",
  description: "Connect to a PostgreSQL server and run a query.",
  target: {
    kind: "url",
    label: "Connection string",
    placeholder: "postgres://user:pass@db.example.com:5432/app",
    help: "The full connection string, credentials included. They are stored like any other monitor setting, so point it at a role that can connect and nothing more.",
  },
  // The port is already in the connection string. A separate field for
  // it would be a second answer to the same question.
  port: { required: false, default: null },
  facts: [
    { key: "responseTimeMs", label: "Query time", kind: "number", unit: "ms" },
    { key: "queryOk", label: "Query answered", kind: "boolean" },
  ],
  form: [],
  supportsRecovery: true,
};

export const mysqlDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "mysql",
  label: "MySQL / MariaDB",
  description: "Read the handshake a MySQL or MariaDB server sends on connect.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "db.example.com",
    help: "A bare hostname, no scheme, no port.",
  },
  port: { required: true, default: DEFAULT_MYSQL_PORT },
  facts: [
    { key: "serverVersion", label: "Server version", kind: "string" },
    { key: "handshakeOk", label: "Handshake read", kind: "boolean" },
    { key: "protocolVersion", label: "Protocol version", kind: "number" },
    { key: "serverError", label: "Server error", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const mongodbDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "mongodb",
  label: "MongoDB",
  description:
    "Run the hello handshake a MongoDB server answers unauthenticated.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "mongo.example.com",
    help: "A bare hostname, no scheme, no connection string.",
  },
  port: { required: true, default: DEFAULT_MONGODB_PORT },
  facts: [
    {
      key: "responseTimeMs",
      label: "Handshake time",
      kind: "number",
      unit: "ms",
    },
    { key: "helloOk", label: "Answered hello", kind: "boolean" },
    { key: "maxWireVersion", label: "Wire version", kind: "number" },
    { key: "isPrimary", label: "Writable primary", kind: "boolean" },
    { key: "replicaSet", label: "Replica set", kind: "string" },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const redisDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "redis",
  label: "Redis",
  description: "Send a PING to a Redis server and read what comes back.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "cache.example.com",
    help: "A bare hostname, no scheme, no port.",
  },
  port: { required: true, default: DEFAULT_REDIS_PORT },
  facts: [
    { key: "pong", label: "Answered PONG", kind: "boolean" },
    { key: "authRequired", label: "Requires authentication", kind: "boolean" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 512 },
      help: "Sent as AUTH before the PING. Leave it empty only for a server that answers unauthenticated: one that wants a password answers every command with a RESP error, an error is not a failed PING, and the monitor reads up having proved nothing.",
    },
  ],
  supportsRecovery: true,
};

export const dockerDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "docker",
  label: "Docker container",
  description: "Ask a Docker daemon whether a named container is running.",
  target: {
    kind: "hostname",
    label: "Docker host",
    placeholder: "docker-1.example.com",
    help: "The machine whose daemon is asked. With the default local socket this is a label.",
  },
  port: null,
  facts: [
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
    { key: "running", label: "Running", kind: "boolean" },
    { key: "state", label: "State", kind: "string" },
    { key: "health", label: "Health", kind: "string" },
    { key: "restartCount", label: "Restarts", kind: "number" },
    { key: "containerId", label: "Container id", kind: "string" },
    { key: "restartLoop", label: "Restart loop", kind: "string" },
  ],
  form: [],
  configFields: [
    {
      name: "containerName",
      emptyValue: "null",
      label: "Container",
      control: { kind: "text", placeholder: "web-1", maxLength: 255 },
      help: "The container's name or id, as `docker ps` prints it. It is matched exactly, so a container recreated under a different name reads as missing, and a missing container is judged down.",
    },
    {
      // Primary rather than advanced, even though the default is right
      // nine times in ten: this field — not the Docker host field — is
      // what decides which machine is asked, and hiding it is how a
      // monitor ends up quietly watching the wrong daemon.
      name: "socketPath",
      emptyValue: "omit",
      label: "Daemon address",
      control: {
        kind: "text",
        placeholder: DEFAULT_DOCKER_SOCKET,
        maxLength: 255,
        mono: true,
      },
      help: `The daemon this monitor asks: a socket path, or \`tcp://host:2375\` for an engine on another machine. Left at ${DEFAULT_DOCKER_SOCKET} the local daemon is asked and the Docker host field is only a label, whatever hostname it holds.`,
    },
    {
      name: "restartLoopEnabled",
      label: "Detect restart loops",
      control: { kind: "boolean" },
      defaultValue: true,
      group: "advanced",
      help: "When yes, a rising restart count inside the window below marks the container down. The first sample only records the count, so a container that has already restarted is not an alarm. Turning this off still stores the count.",
    },
    {
      name: "restartLoopThreshold",
      label: "Restarts in the window",
      control: { kind: "number", min: 1, max: 100, step: 1 },
      defaultValue: "3",
      group: "advanced",
      help: "How far the restart count has to rise inside the window before the monitor is down. The default is 3.",
    },
    {
      name: "restartLoopWindowMinutes",
      label: "Restart window",
      control: { kind: "number", min: 1, max: 1440, step: 1, unit: "min" },
      defaultValue: "10",
      group: "advanced",
      help: "Minutes the restart count is compared across. The default is 10. A gap longer than this, or a new container id, starts the count again.",
    },
    {
      name: "unhealthyIsDown",
      label: "Unhealthy counts as down",
      control: { kind: "boolean" },
      defaultValue: true,
      group: "advanced",
      help: "When yes, a HEALTHCHECK status of unhealthy is down. The failure window still has to elapse before an incident opens. When no, unhealthy stays degraded and does not open an incident.",
    },
  ],
  supportsRecovery: true,
};

export const mqttDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "mqtt",
  label: "MQTT broker",
  description:
    "Connect to an MQTT broker and read the CONNACK it answers with.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "broker.example.com",
    help: "A bare hostname, no scheme, no port.",
  },
  port: { required: true, default: 1883 },
  facts: [
    { key: "connack", label: "CONNACK received", kind: "boolean" },
    { key: "returnCode", label: "Return code", kind: "number" },
    { key: "returnMessage", label: "Broker response", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "username",
      emptyValue: "null",
      label: "Username",
      control: { kind: "text", placeholder: "vigil", maxLength: 255 },
      help: "Set this when the broker requires credentials. Without it, a broker that refuses anonymous connects answers a CONNACK refusing the connection, and the monitor reads as down while the broker is perfectly healthy.",
    },
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 255 },
      help: "Sent inside the CONNECT packet as it is: this check speaks plaintext MQTT only, so port 8883 will never answer and a password here is readable on the path. A password with no username is forbidden by the protocol and refused.",
    },
  ],
  supportsRecovery: true,
};

export const smtpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "smtp",
  label: "SMTP",
  description: "Greet a mail server and check that it accepts EHLO.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "mail.example.com",
    help: "A bare hostname, no scheme, no port. The conversation is plaintext, so port 465 (implicit TLS) will never answer; use 25, 587 or 2525.",
  },
  port: { required: true, default: DEFAULT_SMTP_PORT },
  facts: [
    { key: "greetingCode", label: "Greeting code", kind: "number" },
    { key: "ehloAccepted", label: "EHLO accepted", kind: "boolean" },
    { key: "banner", label: "Banner", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const jsonQueryDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "json-query",
  label: "JSON query",
  description: "Fetch a JSON endpoint and assert on one value inside the body.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "https://example.com/health",
    help: "The full URL of an endpoint that answers with JSON.",
  },
  port: { required: false, default: null },
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
    { key: "jsonValid", label: "Body parsed as JSON", kind: "boolean" },
    { key: "pathFound", label: "Path found", kind: "boolean" },
    { key: "actualValue", label: "Value at path", kind: "string" },
    { key: "matches", label: "Value matches", kind: "boolean" },
  ],
  // No shared form section: the path and the expected value are this
  // type's own config, not something another type renders too.
  form: [],
  configFields: [
    {
      name: "jsonPath",
      emptyValue: "omit",
      label: "JSON path",
      control: {
        kind: "text",
        placeholder: "status",
        maxLength: 200,
        mono: true,
      },
      help: "Dotted, into the response body: status, db.connected, checks[0].name. The default watches for a status field, which is the convention this type exists for and wrong for every endpoint that does not follow it.",
    },
    {
      name: "expectedValue",
      emptyValue: "omit",
      label: "Expected value",
      control: { kind: "text", placeholder: "ok", maxLength: 200, mono: true },
      help: 'Compared as text against whatever is at that path, so true, 1 and ok all work with no type picker. The price is that 1 and "1" are the same answer here.',
    },
  ],
  supportsRecovery: true,
};

/**
 * The default tolerance on a heartbeat's deadline, in seconds.
 *
 * Not zero, and the reason is arithmetic rather than kindness: a cron
 * that fires every 60 seconds does not deliver every 60.000 seconds,
 * and the evaluation that judges it is itself aligned to a tick. With
 * no tolerance, the two clocks eventually land the wrong way round and
 * a job that never missed a beat records a failed observation. Thirty
 * seconds is half a tick period — long enough to absorb that, short
 * enough that a job which genuinely stopped is still caught inside the
 * operator's failure window.
 */
export const DEFAULT_HEARTBEAT_GRACE_SECONDS = 30;

export const pushDescriptor: CheckTypeDescriptor<"passive"> = {
  kind: "passive",
  id: "push",
  label: "Push heartbeat",
  description:
    "Wait for a job to check in, and go down when it stops checking in.",
  target: {
    kind: "label",
    label: "Job name",
    placeholder: "nightly-backup",
    help: "What reports in. Nothing is dialled, this names the job in incidents, emails and on status pages.",
  },
  port: null,
  facts: [
    { key: "heartbeatReceived", label: "Ever checked in", kind: "boolean" },
    {
      key: "secondsSinceHeartbeat",
      label: "Silent for",
      kind: "number",
      unit: "s",
    },
    { key: "reportedStatus", label: "Last report", kind: "string" },
    { key: "reportedMessage", label: "Message", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Job duration",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["heartbeatGrace"],
  configFieldsOmitted: {
    token:
      "Generated, not typed. A browser is handed SECRET_MASK in its " +
      "place, and the URL that carries it is revealed and rotated " +
      "through the push-endpoint control instead.",
  },
  // Recovery verifies a fix by re-probing, and there is nothing here to
  // re-probe: the only thing that can prove a push monitor healthy is
  // the job itself checking in, on its own schedule.
  supportsRecovery: false,
};

export const groupDescriptor: CheckTypeDescriptor<"aggregate"> = {
  kind: "aggregate",
  id: "group",
  label: "Group",
  description: "Roll several monitors up into one state, derived from theirs.",
  target: {
    kind: "label",
    label: "What this group covers",
    placeholder: "EU region",
    help: "A one-line description of the thing the members add up to. Shown wherever a target would be.",
  },
  port: null,
  facts: [
    { key: "memberCount", label: "Members", kind: "number" },
    { key: "downMembers", label: "Down", kind: "number" },
    { key: "degradedMembers", label: "Degraded", kind: "number" },
    { key: "unmeasuredMembers", label: "Not measured", kind: "number" },
    { key: "worstMember", label: "Worst member", kind: "string" },
    {
      key: "memberIntervalSeconds",
      label: "Slowest member reports every",
      kind: "number",
      unit: "s",
    },
  ],
  // Membership is the only setting a group has, and it is stored on the
  // members — a child names its group, not the other way round, so that
  // deleting a group cannot take its members with it.
  form: [],
  supportsRecovery: false,
};

export const manualDescriptor: CheckTypeDescriptor<"manual"> = {
  kind: "manual",
  id: "manual",
  label: "Manual",
  description:
    "A status an operator sets by hand, for what Vigil cannot reach.",
  target: {
    kind: "label",
    label: "What this tracks",
    placeholder: "Stripe payments",
    help: "The thing you are vouching for. A vendor, a physical site, anything with no endpoint to dial.",
  },
  port: null,
  facts: [
    { key: "declaredStatus", label: "Set to", kind: "string" },
    { key: "declaredNote", label: "Note", kind: "string" },
  ],
  form: ["manualStatus"],
  supportsRecovery: false,
};

/**
 * The management plugin's own port. Not a `port` field on the
 * descriptor: the target is a URL, so the port is already in it, and a
 * second field for it would be a second answer to the same question.
 * Kept as a constant because the placeholder and the docs both quote it.
 */
export const DEFAULT_RABBITMQ_MANAGEMENT_PORT = 15672;

export const rabbitmqDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "rabbitmq",
  label: "RabbitMQ",
  description:
    "Ask a RabbitMQ node's management API whether its health checks pass.",
  target: {
    kind: "url",
    label: "Management API URL",
    placeholder: `https://rabbit.example.com:${DEFAULT_RABBITMQ_MANAGEMENT_PORT}`,
    help: `The base URL of the management plugin, including its port (${DEFAULT_RABBITMQ_MANAGEMENT_PORT} unless it sits behind a proxy). Vigil appends the health-check path itself.`,
  },
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    { key: "alarmsClear", label: "Health check passed", kind: "boolean" },
    { key: "alarmReason", label: "Node's reason", kind: "string" },
    RESPONSE_TIME,
  ],
  // Credentials are this type's only setting and the form has no section
  // for them yet; they arrive by import or by API. See the spec.
  form: [],
  configFields: [
    {
      name: "username",
      emptyValue: "null",
      label: "Management username",
      control: { kind: "text", placeholder: "vigil", maxLength: 255 },
      help: "The management API authenticates every request, so a monitor with no user gets a 401 and reports misconfigured: never up, never down. Give it a user with the `monitoring` tag, which can read the health checks and nothing else.",
    },
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 255 },
      help: "Sent as HTTP Basic, in the clear unless the URL is `https://`. A password with no username is refused: Basic carries one `user:password` field, and a silently unsent password comes back as a 401 that reads like a wrong one.",
    },
  ],
  supportsRecovery: true,
};

export const DEFAULT_KAFKA_PORT = 9092;

/**
 * The record every Kafka check publishes.
 *
 * Here rather than in the spec because the form's placeholder quotes it,
 * and the form may not import a spec — that would pull zod and a broker
 * client into the browser bundle.
 */
export const DEFAULT_KAFKA_MESSAGE = "vigil monitor check";

export const kafkaProducerDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "kafka-producer",
  label: "Kafka producer",
  description:
    "Publish one message to a Kafka topic and read the broker's acknowledgement.",
  target: {
    kind: "hostname",
    label: "Bootstrap broker",
    placeholder: "kafka-1.example.com",
    help: "A bare hostname, no scheme, no port. Vigil asks this broker which node leads the topic and produces to that one.",
  },
  port: { required: true, default: DEFAULT_KAFKA_PORT },
  facts: [
    { key: "brokerCount", label: "Brokers in cluster", kind: "number" },
    { key: "topicFound", label: "Topic exists", kind: "boolean" },
    { key: "partitionCount", label: "Partitions", kind: "number" },
    { key: "produced", label: "Message accepted", kind: "boolean" },
    { key: "baseOffset", label: "Written at offset", kind: "number" },
    { key: "brokerError", label: "Broker error", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  configFields: [
    {
      name: "topic",
      emptyValue: "null",
      label: "Topic",
      control: {
        kind: "text",
        placeholder: "vigil-monitor-checks",
        // Kafka's own Topic.MAX_NAME_LENGTH. Repeated from the spec as a
        // courtesy; storedSchema stays the authority.
        maxLength: 249,
        mono: true,
      },
      help: "One record is produced to this topic on every check, so point it at a topic you own; every consumer of it sees the message. Without a topic nothing is dialled at all and the monitor reports misconfigured.",
    },
    {
      name: "tls",
      defaultValue: false,
      label: "Connect with TLS",
      control: { kind: "boolean" },
      help: "On for an `SSL` or `SASL_SSL` listener, off for `PLAINTEXT`. SASL/PLAIN puts the password on the wire as it is, so a credential set without this is readable by anything on the path. The certificate is verified; a private CA belongs in NODE_EXTRA_CA_CERTS.",
    },
    {
      name: "username",
      emptyValue: "null",
      label: "SASL username",
      control: { kind: "text", placeholder: "vigil", maxLength: 255 },
      help: "Only for a listener that demands SASL/PLAIN. Leave it empty on a cluster that takes anonymous connections: a credential offered to a listener with no SASL configured is refused at the handshake and reports misconfigured.",
    },
    {
      name: "password",
      emptyValue: "null",
      label: "SASL password",
      control: { kind: "secret", maxLength: 255 },
      help: "Needs a username: PLAIN sends both as one token, so a password on its own cannot be put on the wire. Turn on TLS before you set one.",
    },
    {
      name: "message",
      emptyValue: "omit",
      label: "Message",
      control: {
        kind: "text",
        placeholder: DEFAULT_KAFKA_MESSAGE,
        maxLength: 512,
      },
      help: "The record's value. The default names its author, so a record found in the topic six months later is traceable; change it only when your consumers validate a schema.",
      group: "advanced",
    },
  ],
  supportsRecovery: true,
};

export const DEFAULT_MEMCACHED_PORT = 11211;

export const memcachedDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "memcached",
  label: "Memcached",
  description:
    "Ask a memcached server for its version and read the counters behind it.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "cache.example.com",
    help: "A bare hostname, no scheme, no port.",
  },
  port: { required: true, default: DEFAULT_MEMCACHED_PORT },
  facts: [
    { key: "version", label: "Server version", kind: "string" },
    { key: "uptimeSeconds", label: "Uptime", kind: "number", unit: "s" },
    { key: "currentConnections", label: "Open connections", kind: "number" },
    { key: "maxConnections", label: "Connection limit", kind: "number" },
    {
      key: "connectionUsagePercent",
      label: "Connection limit in use",
      kind: "number",
      unit: "%",
    },
    // The server's own words when it refuses. A memcached that answers
    // `ERROR` and one that never answered at all are different
    // incidents, and only one of them is a network problem.
    { key: "serverError", label: "Server error", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  configFields: [
    {
      name: "username",
      emptyValue: "null",
      label: "Username",
      control: { kind: "text", placeholder: "monitor", maxLength: 255 },
      help: "The user from the server's --auth-file (memcached 1.5.16 and later). Leave this and the password empty for a server that accepts unauthenticated commands; SASL over the binary protocol is a different mechanism and is not supported.",
    },
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 255 },
      help: "Offered only after the server refuses an unauthenticated command, so it is never written into the cache as an ordinary key. A password with no username is refused: the auth file pairs them.",
    },
    {
      name: "maxConnectionUsagePercent",
      emptyValue: "null",
      label: "Connection limit warning",
      control: { kind: "number", min: 1, max: 100, step: 1, unit: "%" },
      group: "advanced",
      help: "Share of the server's maxconns in use before the monitor goes amber; it never opens an incident. Leave it empty to make no claim about connection usage; a monitor created outside this form takes 90.",
    },
  ],
  supportsRecovery: true,
};

/**
 * Elasticsearch's REST port. Not a `port` field on the descriptor: the
 * target is a URL, so the port is already in it, and a second field for
 * it would be a second answer to the same question. Kept as a constant
 * because the placeholder and the docs both quote it.
 */
export const DEFAULT_ELASTICSEARCH_PORT = 9200;

/**
 * The cluster colours that can count as healthy. Red never can.
 *
 * Here rather than in the spec for the reason the Kafka message is: the
 * form types its options against this, and the form cannot import a spec.
 */
export const ACCEPTABLE_CLUSTER_STATUSES = ["green", "yellow"] as const;

export const elasticsearchDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "elasticsearch",
  label: "Elasticsearch",
  description:
    "Read a cluster's health endpoint and judge it by the status color.",
  target: {
    kind: "url",
    label: "Cluster URL",
    placeholder: `https://search.example.com:${DEFAULT_ELASTICSEARCH_PORT}`,
    help: `The base URL of any node in the cluster, including its port (${DEFAULT_ELASTICSEARCH_PORT} unless it sits behind a proxy). Vigil appends the cluster-health path itself.`,
  },
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    { key: "clusterStatus", label: "Cluster status", kind: "string" },
    { key: "clusterName", label: "Cluster name", kind: "string" },
    { key: "nodeCount", label: "Nodes", kind: "number" },
    { key: "unassignedShards", label: "Unassigned shards", kind: "number" },
    {
      key: "activeShardsPercent",
      label: "Active shards",
      kind: "number",
      unit: "%",
    },
    RESPONSE_TIME,
  ],
  // Credentials are this type's only setting and the form has no section
  // for them yet; they arrive by import or by API. See the spec.
  form: [],
  configFields: [
    {
      name: "username",
      emptyValue: "null",
      label: "Username",
      control: { kind: "text", placeholder: "elastic", maxLength: 255 },
      help: "HTTP basic, for a cluster with security enabled. Put it here and not in the cluster URL: the URL is exported and printed verbatim, and this field is masked everywhere.",
    },
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 512 },
      help: "A password needs a username. A cluster that refuses it answers 401, which reports misconfigured rather than down, because the cluster is up and refusing us.",
    },
    {
      name: "apiKey",
      emptyValue: "null",
      label: "API key",
      control: { kind: "secret", maxLength: 1024 },
      help: "Sent as an ApiKey authorization header, instead of a username and password rather than as well as them: saving both is refused. A key holding only the cluster monitor privilege is all this check needs.",
    },
    {
      name: "minimumStatus",
      defaultValue: "green",
      emptyValue: "omit",
      label: "Lowest healthy status",
      control: {
        kind: "select",
        // Typed against the enum rather than restating it, so a colour
        // `storedSchema` would refuse cannot be offered in the form.
        options: [
          { value: "green", label: "Green (yellow is degraded)" },
          { value: "yellow", label: "Yellow (normal on a single node)" },
        ] satisfies readonly {
          value: (typeof ACCEPTABLE_CLUSTER_STATUSES)[number];
          label: string;
        }[],
      },
      help: "The worst colour that still counts as fully healthy; red is down either way. A single-node cluster is permanently yellow (it has replicas configured and nowhere to put them), so green there makes the monitor amber from the day it is created.",
    },
  ],
  supportsRecovery: true,
};

export const websocketDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "websocket",
  label: "WebSocket",
  description:
    "Complete the upgrade handshake and check the server answers as a WebSocket.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "wss://example.com/socket",
    help: "The full ws:// or wss:// URL, path included. Put the port in the URL.",
  },
  // The URL already carries the port, exactly as it does for `http`. A
  // separate field would be a second answer to the same question, and
  // the two would disagree the first time someone edited one of them.
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    { key: "acceptValid", label: "Handshake key accepted", kind: "boolean" },
    { key: "subprotocol", label: "Subprotocol", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Handshake time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: [],
  configFields: [
    {
      name: "subprotocol",
      emptyValue: "null",
      label: "Subprotocol",
      control: {
        kind: "text",
        placeholder: "graphql-ws",
        maxLength: 64,
        mono: true,
      },
      help: "A single token, offered in Sec-WebSocket-Protocol. With one set, a server that accepts the socket without agreeing to it is a failure, which is the point: a gateway that answers every path is not the application.",
    },
    {
      name: "authorization",
      emptyValue: "null",
      label: "Authorization header",
      control: { kind: "secret", placeholder: "Bearer ...", maxLength: 2048 },
      help: "Sent verbatim as the Authorization header on the handshake. Include the scheme.",
    },
  ],
  supportsRecovery: true,
};

/**
 * What a plaintext gRPC server listens on by convention — there is no
 * IANA assignment, and the whole ecosystem's examples use this. A TLS
 * endpoint is normally behind 443, which the operator types.
 */
export const DEFAULT_GRPC_PORT = 50051;

export const grpcDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "grpc",
  label: "gRPC health check",
  description:
    "Call the standard gRPC health service and read the status it reports.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "api.example.com",
    help: "A bare hostname, no scheme, no port. Plaintext HTTP/2 unless the monitor is set to use TLS.",
  },
  port: { required: true, default: DEFAULT_GRPC_PORT },
  facts: [
    { key: "httpStatus", label: "HTTP status", kind: "number" },
    { key: "grpcStatus", label: "gRPC status", kind: "number" },
    { key: "grpcMessage", label: "gRPC message", kind: "string" },
    { key: "servingStatus", label: "Reported status", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "tls",
      defaultValue: false,
      label: "TLS",
      control: { kind: "boolean" },
      help: "On for a server behind TLS. Dialling a TLS port in plaintext does not fail politely; the connection stalls and the check times out.",
    },
    {
      name: "service",
      emptyValue: "empty",
      label: "Service name",
      control: {
        kind: "text",
        placeholder: "grpc.health.v1.Health",
        maxLength: 200,
        mono: true,
      },
      help: "Which service to ask about. Leave it empty to ask whether the whole server is serving.",
    },
    {
      name: "authorization",
      emptyValue: "null",
      label: "Authorization metadata",
      control: { kind: "secret", placeholder: "Bearer ...", maxLength: 2048 },
      help: "Sent as the authorization metadata entry on the health call. Include the scheme.",
    },
  ],
  supportsRecovery: true,
};

export const DEFAULT_LDAP_PORT = 389;

export const ldapDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ldap",
  label: "LDAP directory",
  description:
    "Bind to a directory server and read the result it answers with.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "ldap.example.com",
    help: "A bare hostname, no scheme, no port. The bind is plaintext, so port 636 (LDAPS) will never answer; use 389, or 3268 for an Active Directory global catalog.",
  },
  port: { required: true, default: DEFAULT_LDAP_PORT },
  facts: [
    { key: "bindResponse", label: "Bind answered", kind: "boolean" },
    { key: "resultCode", label: "Result code", kind: "number" },
    { key: "resultMessage", label: "Result", kind: "string" },
    { key: "diagnosticMessage", label: "Server message", kind: "string" },
    { key: "responseTimeMs", label: "Bind time", kind: "number", unit: "ms" },
  ],
  form: ["port"],
  configFields: [
    {
      name: "bindDn",
      emptyValue: "null",
      label: "Bind DN",
      control: {
        kind: "text",
        placeholder: "cn=vigil,ou=service,dc=example,dc=com",
        maxLength: 512,
        mono: true,
      },
      help: "The DN to bind as. Leave it empty and Vigil binds anonymously, which proves the directory answers but not that it can still authenticate anyone, and a directory that refuses anonymous binds reports every check as down.",
    },
    // No `showWhen` pairing these two: `equals` compares against a fixed
    // list of values, and "the DN is not empty" is not one of those. The
    // rule that a password needs a DN is a refinement in `specs/ldap.ts`,
    // which is where the operator meets it, with the field named.
    {
      name: "bindPassword",
      emptyValue: "null",
      label: "Bind password",
      control: { kind: "secret", maxLength: 512 },
      help: "Sent in the clear: this bind never starts TLS, which is why port 636 is not an option. A password needs a bind DN: on its own the directory ignores it, binds anonymously and answers success.",
    },
  ],
  supportsRecovery: true,
};

export const DEFAULT_SSH_PORT = 22;

export const sshDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ssh",
  label: "SSH",
  description: "Read the version banner an SSH daemon sends when it answers.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "bastion.example.com",
    help: "A bare hostname, no scheme, no port. Nothing is authenticated: Vigil reads the banner the daemon sends first and hangs up.",
  },
  port: { required: true, default: DEFAULT_SSH_PORT },
  facts: [
    { key: "identified", label: "Sent an SSH banner", kind: "boolean" },
    { key: "protocolVersion", label: "Protocol version", kind: "string" },
    { key: "softwareVersion", label: "Software version", kind: "string" },
    { key: "banner", label: "Banner", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "expectedBanner",
      emptyValue: "null",
      label: "Expected banner",
      control: {
        kind: "text",
        placeholder: "OpenSSH_9",
        maxLength: 255,
        mono: true,
      },
      help: "A substring the identification string must contain, which turns this into a version assertion: OpenSSH_9 catches a rollback to an older build, Debian catches a failover onto a different image. Match on as little as you can; a full version reports down the first time the host is patched.",
    },
  ],
  supportsRecovery: true,
};

export const DEFAULT_SQLSERVER_PORT = 1433;
export const DEFAULT_ORACLE_PORT = 1521;

export const sqlserverDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "sqlserver",
  label: "Microsoft SQL Server",
  description: "Sign in to a SQL Server over TDS and run a query.",
  target: {
    kind: "url",
    label: "Connection string",
    placeholder: "sqlserver://user:pass@db.example.com:1433/app",
    help: "The full connection string, credentials included. The login is spoken in plaintext TDS, so a server with Force Encryption on (and Azure SQL, which always requires it). Is watched as far as its TDS greeting and no further.",
  },
  // The port is already in the connection string, exactly as for
  // postgres. A separate field would be a second answer to the same
  // question, and the two would disagree the first time one was edited.
  port: { required: false, default: null },
  facts: [
    { key: "preloginOk", label: "Answered TDS", kind: "boolean" },
    { key: "serverVersion", label: "Server version", kind: "string" },
    {
      key: "encryptionRequired",
      label: "Requires encryption",
      kind: "boolean",
    },
    { key: "loginOk", label: "Signed in", kind: "boolean" },
    { key: "queryOk", label: "Query answered", kind: "boolean" },
    { key: "serverError", label: "Server error", kind: "string" },
    { key: "responseTimeMs", label: "Query time", kind: "number", unit: "ms" },
  ],
  form: [],
  supportsRecovery: true,
};

export const oracledbDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "oracledb",
  label: "Oracle Database",
  description: "Ask an Oracle listener to accept a connection for one service.",
  target: {
    kind: "url",
    label: "Connection string",
    placeholder: "oracle://db.example.com:1521/ORCLPDB1",
    help: "Host, port and service name. No credentials: this check speaks TNS to the listener and never signs in, so a password here would be stored and never sent.",
  },
  port: { required: false, default: null },
  facts: [
    { key: "listenerAnswered", label: "Answered TNS", kind: "boolean" },
    { key: "accepted", label: "Connection accepted", kind: "boolean" },
    { key: "listenerResponse", label: "Listener said", kind: "string" },
    { key: "serviceError", label: "Listener error", kind: "string" },
    { key: "serverVersion", label: "Server version", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: [],
  supportsRecovery: true,
};

export const DEFAULT_IMAP_PORT = 143;

export const imapDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "imap",
  label: "IMAP",
  description:
    "Greet a mail store and check the capabilities it still advertises.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "imap.example.com",
    help: "A bare hostname, no scheme, no port. The conversation is plaintext, so port 993 (implicit TLS) will never answer; use 143.",
  },
  port: { required: true, default: DEFAULT_IMAP_PORT },
  facts: [
    { key: "greetingStatus", label: "Greeting", kind: "string" },
    {
      key: "capabilityAccepted",
      label: "CAPABILITY accepted",
      kind: "boolean",
    },
    { key: "capabilities", label: "Capabilities", kind: "list" },
    { key: "banner", label: "Banner", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "requiredCapability",
      emptyValue: "null",
      label: "Required capability",
      control: {
        kind: "text",
        placeholder: "STARTTLS",
        maxLength: 64,
        mono: true,
      },
      help: "One capability the server must keep advertising: STARTTLS, IDLE, AUTH=PLAIN. Leave it empty to assert only that the store answers; name one the server does not already list and the monitor is down on its first check.",
    },
  ],
  supportsRecovery: true,
};

export const DEFAULT_FTP_PORT = 21;

export const ftpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ftp",
  label: "FTP",
  description:
    "Greet an FTP server, read its feature list, and optionally log in.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "files.example.com",
    help: "A bare hostname, no scheme, no port. The conversation is plaintext, so port 990 (implicit FTPS) will never answer; use 21. Credentials, if you set any, travel in the clear, point them at an account that can do nothing.",
  },
  port: { required: true, default: DEFAULT_FTP_PORT },
  facts: [
    { key: "greetingCode", label: "Greeting code", kind: "number" },
    { key: "banner", label: "Banner", kind: "string" },
    { key: "featCode", label: "FEAT reply", kind: "number" },
    { key: "features", label: "Features", kind: "list" },
    { key: "loginCode", label: "Login reply", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "username",
      emptyValue: "null",
      label: "Username",
      control: { kind: "text", placeholder: "anonymous", maxLength: 128 },
      help: "The account to log in as. Leave it empty and the check stops after the feature list, so an expired or locked account is not something it can see.",
    },
    // Not hidden until a username exists: `showWhen` compares against a
    // fixed list of values, and a stored secret behind a hidden control is
    // a credential the operator can no longer see they have. The pairing
    // rule is a refinement in `specs/ftp.ts`.
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 255 },
      help: "Travels in the clear, because FTP has no other way and this check never issues AUTH TLS, so point it at an account that can list a directory and nothing else. It needs a username: PASS only means anything after USER.",
    },
  ],
  supportsRecovery: true,
};

/** The IANA-assigned SNMP agent port. */
export const DEFAULT_SNMP_PORT = 161;

/**
 * `sysUpTime.0` — the OID every agent answers, from RFC 1213's
 * `system` group. It is the default so that a monitor created with
 * nothing but a hostname is a working monitor: an agent that answers
 * this is an agent that is running, which is what an operator who has
 * not yet decided what to poll actually wants to know.
 */
export const DEFAULT_SNMP_OID = "1.3.6.1.2.1.1.3.0";

/**
 * The SNMP versions Vigil speaks, as they are written on the wire and
 * in every agent's configuration file — "2c" rather than "2", because
 * SNMPv2c (community-based) and SNMPv2u are different protocols and an
 * operator copying a value out of `snmpd.conf` must not have to
 * translate it.
 */
export const SNMP_VERSIONS = ["1", "2c", "3"] as const;

export type SnmpVersion = (typeof SNMP_VERSIONS)[number];

export const snmpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "snmp",
  label: "SNMP",
  description: "Ask an SNMP agent for one OID and judge what it answers.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "switch.example.com",
    help: "A bare hostname, no scheme, no port. SNMP is UDP, so nothing is connected: one request goes out and Vigil waits for one answer. Without further settings it asks for sysUpTime.0 as v2c with the community `public`.",
  },
  port: { required: true, default: DEFAULT_SNMP_PORT },
  facts: [
    { key: "oidFound", label: "OID answered", kind: "boolean" },
    { key: "value", label: "Value", kind: "string" },
    { key: "valueType", label: "Value type", kind: "string" },
    { key: "numericValue", label: "Numeric value", kind: "number" },
    { key: "errorStatus", label: "Agent error", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  configFields: [
    {
      name: "oid",
      emptyValue: "omit",
      label: "OID",
      control: {
        kind: "text",
        placeholder: DEFAULT_SNMP_OID,
        maxLength: 255,
        mono: true,
      },
      help: "Numeric, like 1.3.6.1.2.1.1.3.0. Names out of a MIB are not resolved. The default reads the agent's uptime, which every agent answers.",
    },
    {
      name: "version",
      defaultValue: "2c",
      emptyValue: "omit",
      label: "Version",
      control: {
        kind: "select",
        options: [
          { value: "1", label: "v1" },
          { value: "2c", label: "v2c" },
          { value: "3", label: "v3 (USM)" },
        ],
      },
      help: "v1 and v2c authenticate with a community string and nothing else. v3 identifies the caller by user name and can sign and encrypt.",
    },
    {
      name: "community",
      emptyValue: "null",
      label: "Community string",
      control: { kind: "secret", maxLength: 255 },
      showWhen: { field: "version", equals: ["1", "2c"] },
      help: "The whole of v1 and v2c authentication. `public` unless somebody changed it, and an agent that wants a different one does not answer, which reads as an outage.",
    },
    {
      name: "v3Username",
      emptyValue: "null",
      label: "USM user name",
      control: { kind: "text", maxLength: 64 },
      showWhen: { field: "version", equals: ["3"] },
      help: "Sent in the clear at every security level, so it is not treated as a secret.",
    },
    {
      name: "v3AuthProtocol",
      emptyValue: "null",
      label: "Authentication",
      control: {
        kind: "select",
        options: [
          { value: "", label: "None (noAuthNoPriv)" },
          { value: "MD5", label: "MD5" },
          { value: "SHA", label: "SHA" },
        ],
      },
      showWhen: { field: "version", equals: ["3"] },
    },
    {
      name: "v3AuthPassword",
      emptyValue: "null",
      label: "Authentication pass phrase",
      control: { kind: "secret", maxLength: 255 },
      showWhen: { field: "version", equals: ["3"] },
    },
    {
      name: "v3PrivProtocol",
      emptyValue: "null",
      label: "Privacy",
      control: {
        kind: "select",
        options: [
          { value: "", label: "None" },
          { value: "AES", label: "AES-128" },
        ],
      },
      showWhen: { field: "version", equals: ["3"] },
      help: "USM has no encrypt-without-authenticate level, so this needs an authentication protocol as well.",
    },
    {
      name: "v3PrivPassword",
      emptyValue: "null",
      label: "Privacy pass phrase",
      control: { kind: "secret", maxLength: 255 },
      showWhen: { field: "version", equals: ["3"] },
    },
    {
      name: "expectedValue",
      emptyValue: "null",
      label: "Expected value",
      control: { kind: "text", maxLength: 255, mono: true },
      help: "Leave empty to require only that the OID answers.",
      group: "advanced",
    },
  ],
  supportsRecovery: true,
};

/**
 * The systemd unit suffixes a monitor may name.
 *
 * Enumerated rather than accepting any suffix, and required rather than
 * defaulting to `.service` the way `systemctl start nginx` does: a
 * monitor is read by whoever is woken at 3am, and "nginx" leaves them
 * guessing whether the socket, the timer or the service is the one
 * being watched. The suffix is one keystroke and removes the question.
 */
export const SYSTEMD_UNIT_SUFFIXES = [
  "service",
  "socket",
  "target",
  "timer",
  "mount",
  "automount",
  "path",
  "slice",
  "scope",
  "device",
  "swap",
] as const;

export const systemServiceDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "system-service",
  label: "System service",
  description: "Ask the local systemd whether one of its units is active.",
  target: {
    kind: "label",
    // Not a hostname, and the help text has to say so: this is the one
    // check type whose subject is the machine Vigil itself runs on.
    // Naming a host here would be a promise that some other machine is
    // being asked, and nothing would ever dial it.
    label: "Unit name",
    placeholder: "nginx.service",
    help: "A systemd unit on the machine this worker runs on, suffix included. Nothing is dialled (the local init system is asked) so this monitor speaks for that one machine and no other.",
  },
  port: null,
  facts: [
    { key: "activeState", label: "Active state", kind: "string" },
    { key: "subState", label: "Sub state", kind: "string" },
    { key: "loadState", label: "Load state", kind: "string" },
    { key: "unitFileState", label: "Unit file state", kind: "string" },
    { key: "restarts", label: "Restarts", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: [],
  // systemd, on this machine, reachable by this process. Where it is
  // absent — a container, a BSD, a distribution that runs something
  // else — the monitor reads `misconfigured` and says why, because an
  // operator error that looks like an outage is the one failure a
  // monitoring product may not have.
  requiresCapability: "systemd",
  supportsRecovery: true,
};

/**
 * The query port a Source server listens on. Usually the game port, and
 * usually 27015 — but a box running four servers gives three of them
 * something else, which is why the port is required rather than assumed.
 */
export const DEFAULT_STEAM_PORT = 27015;

export const steamDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "steam",
  label: "Steam game server",
  description:
    "Ask a Source or GoldSrc server for the A2S_INFO reply a player's client reads.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "cs.example.com",
    help: "A bare hostname, no scheme. The port is the server's query port, which is the game port on all but the most crowded boxes.",
  },
  port: { required: true, default: DEFAULT_STEAM_PORT },
  facts: [
    { key: "answered", label: "Answered A2S_INFO", kind: "boolean" },
    { key: "serverName", label: "Server name", kind: "string" },
    { key: "map", label: "Map", kind: "string" },
    { key: "game", label: "Game", kind: "string" },
    { key: "players", label: "Players", kind: "number" },
    { key: "maxPlayers", label: "Player slots", kind: "number" },
    { key: "bots", label: "Bots", kind: "number" },
    { key: "vacSecured", label: "VAC secured", kind: "boolean" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  supportsRecovery: true,
};

/**
 * The query protocols the `gamedig` type speaks, and the port each one
 * conventionally answers on.
 *
 * Three families rather than a game list, and the distinction is the
 * whole honesty of this type. GameDig — the library Uptime Kuma calls —
 * ships a table of some three hundred game ids; nearly all of them
 * resolve to one of these three wire protocols, and the table's real
 * content is which port and which quirk each title uses. Vigil speaks
 * the protocols and does not have the table, so it asks the operator
 * for the protocol and the port instead of pretending to know the game.
 * See `docs/GAME-SERVERS.md` for exactly what that costs.
 *
 * Lives in the catalog, beside `DNS_RECORD_TYPES`, so the monitor form
 * can render the choice without importing zod.
 */
export const GAME_QUERY_PROTOCOL_IDS = [
  "source",
  "minecraft",
  "quake3",
] as const;

export type GameQueryProtocol = (typeof GAME_QUERY_PROTOCOL_IDS)[number];

/**
 * What each protocol is called and where it usually listens. Separate
 * from the id tuple above because `z.enum` wants the ids and nothing
 * else, and a schema built from `.map()` over this list would be a
 * `string[]` the compiler could no longer check the config against.
 */
export const GAME_QUERY_PROTOCOLS: readonly {
  id: GameQueryProtocol;
  label: string;
  defaultPort: number;
  /** Titles this family covers, for the form's help text. */
  games: string;
}[] = [
  {
    id: "source",
    label: "Source / GoldSrc (A2S)",
    defaultPort: DEFAULT_STEAM_PORT,
    games: "Counter-Strike, Team Fortress, Garry's Mod, Rust, ARK, Valheim",
  },
  {
    id: "minecraft",
    label: "Minecraft (query)",
    defaultPort: 25565,
    games: "Minecraft, with enable-query=true in server.properties",
  },
  {
    id: "quake3",
    label: "id Tech 3 (getstatus)",
    defaultPort: 27960,
    games: "Quake III, Call of Duty, Wolfenstein: Enemy Territory, OpenArena",
  },
];

export const gamedigDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "gamedig",
  label: "Game server (UDP query)",
  description:
    "Query a game server directly: Source/GoldSrc, Minecraft or id Tech 3.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "mc.example.com",
    help: "A bare hostname, no scheme. The port is the server's query port: 27015 for Source, 25565 for Minecraft, 27960 for id Tech 3.",
  },
  // No default: the right port is a property of the protocol, and one
  // guess would be wrong for two thirds of the servers this watches.
  // Required with a null default is what makes the form ask for it.
  port: { required: true, default: null },
  facts: [
    { key: "answered", label: "Answered the query", kind: "boolean" },
    { key: "serverName", label: "Server name", kind: "string" },
    { key: "map", label: "Map", kind: "string" },
    { key: "players", label: "Players", kind: "number" },
    { key: "maxPlayers", label: "Player slots", kind: "number" },
    RESPONSE_TIME,
  ],
  // The protocol is this type's only setting and the monitor form has no
  // section for it yet, so a monitor created in the UI queries Source and
  // one created by import or API queries whatever it asked for. Same
  // shape as `rabbitmq`'s credentials; both want a form section.
  form: ["port"],
  configFields: [
    {
      name: "protocol",
      defaultValue: "source",
      emptyValue: "omit",
      label: "Query protocol",
      control: {
        kind: "select",
        // Derived from the list above rather than restated, so a fourth
        // protocol is one edit. No empty option: `protocol` is a
        // required enum with a default, and "not set" is not a value
        // `gamedigStoredSchema` accepts.
        options: GAME_QUERY_PROTOCOLS.map((entry) => ({
          value: entry.id,
          label: entry.label,
        })),
      },
      help: `Which query Vigil sends. ${GAME_QUERY_PROTOCOLS.map(
        (entry) => `${entry.label}: ${entry.games}`,
      ).join(
        ". ",
      )}. The wrong one for this port draws no reply at all, so a server that is running reads as down.`,
    },
  ],
  supportsRecovery: true,
};

/**
 * The three datagram types.
 *
 * UDP has no handshake, so none of them can borrow TCP's proof of life:
 * a connect that completes says a service is there, and a datagram that
 * is sent says only that the kernel accepted it. The evidence has to be
 * a *reply*, which is why all three send a payload the far end is
 * obliged to answer and why silence is reported as "no reply" rather
 * than as a connection failure — nothing was ever connected.
 */

/** RFC 5905. */
export const DEFAULT_NTP_PORT = 123;
/**
 * RFC 2865's authentication port. 1645 is the pre-standard one many
 * vendors still listen on, which is why the port field is offered even
 * though this default is right for most estates.
 */
export const DEFAULT_RADIUS_PORT = 1812;

export const udpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "udp",
  label: "UDP port",
  description: "Send a datagram to a UDP port and wait for a reply.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "dns.example.com",
    help: "A bare hostname, no scheme, no port. UDP answers nothing it was not asked, so the check needs a payload the service will reply to.",
  },
  // No default, and required: there is no such thing as "the" UDP port.
  // A default here would be a guess dressed as a setting.
  port: { required: true, default: null },
  facts: [
    { key: "replyBytes", label: "Reply size", kind: "number", unit: "bytes" },
    { key: "replyPreview", label: "Reply", kind: "string" },
    { key: "responseMatches", label: "Reply matched", kind: "boolean" },
    RESPONSE_TIME,
  ],
  // The payload and the expected reply are this type's own config. The
  // monitor form renders no section for them yet, so a monitor created
  // in the UI sends an empty datagram and one created by import or API
  // sends what it asked for.
  form: ["port"],
  configFields: [
    {
      name: "payloadEncoding",
      defaultValue: "text",
      emptyValue: "null",
      label: "Payload encoding",
      // Values are `UDP_PAYLOAD_ENCODINGS` — see the note on that
      // constant. Declared here because the form must render this
      // selector without importing the spec (and therefore zod).
      control: {
        kind: "select",
        options: [
          { value: "text", label: "Text" },
          { value: "hex", label: "Hex" },
        ],
      },
      help: "How the payload and the expected reply below are written. Text goes on the wire as UTF-8; hex as the bytes those digit pairs spell, like `00ff2a`. The reply is read the same way, so a hex payload needs a hex expectation.",
    },
    {
      name: "payload",
      emptyValue: "null",
      label: "Payload",
      control: { kind: "text", maxLength: 4096, mono: true },
      help: "What the check sends. UDP answers nothing it was not asked, so an empty payload means most services never reply and the monitor reads down whether or not they are healthy. Trailing whitespace is kept: it is the terminator half the text protocols use. 1024 bytes maximum: a larger datagram is fragmented, and firewalls routinely drop the fragments.",
    },
    {
      name: "expectedResponse",
      emptyValue: "null",
      label: "Expected reply contains",
      control: { kind: "text", maxLength: 200 },
      help: "A substring the reply must contain, read in the encoding above. Leave it empty and any reply at all counts as up, including an error the service sends back or an unrelated process bound on that port.",
    },
  ],
  supportsRecovery: true,
};

export const ntpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ntp",
  label: "NTP server",
  description: "Ask a time server for the time and compare it with Vigil's.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "time.example.com",
    help: "A bare hostname, no scheme, no port. One server, not a pool name: a pool answers from a different machine every check, so a bad member hides in the average.",
  },
  port: { required: false, default: DEFAULT_NTP_PORT },
  facts: [
    { key: "stratum", label: "Stratum", kind: "number" },
    { key: "leapIndicator", label: "Leap indicator", kind: "number" },
    { key: "offsetMs", label: "Clock offset", kind: "number", unit: "ms" },
    { key: "delayMs", label: "Round-trip delay", kind: "number", unit: "ms" },
    { key: "referenceId", label: "Reference", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  configFields: [
    {
      name: "maxOffsetMs",
      emptyValue: "null",
      label: "Clock offset tolerance",
      control: { kind: "number", min: 1, max: 3_600_000, unit: "ms" },
      help: "How far the server's clock may sit from Vigil's before the check reads degraded. The offset is measured against this host's clock, not against真 time, so tightening it much below the 1000ms default reports Vigil's own drift as every time server drifting at once.",
      group: "advanced",
    },
  ],
  supportsRecovery: true,
};

export const radiusDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "radius",
  label: "RADIUS",
  description: "Send an Access-Request and read the answer it is signed with.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "radius.example.com",
    help: "A bare hostname, no scheme, no port. The shared secret and the test account are settings, not part of the address.",
  },
  port: { required: false, default: DEFAULT_RADIUS_PORT },
  facts: [
    { key: "replyCode", label: "Reply code", kind: "number" },
    { key: "replyType", label: "Reply", kind: "string" },
    {
      key: "authenticatorValid",
      label: "Reply signed with our secret",
      kind: "boolean",
    },
    RESPONSE_TIME,
  ],
  // The shared secret and the test account are this type's own config.
  // The monitor form renders no section for them yet, so a monitor
  // created in the UI reports `misconfigured` until one is supplied by
  // import or API — which is the correct answer, and never `down`.
  form: ["port"],
  configFields: [
    {
      name: "secret",
      emptyValue: "null",
      label: "Shared secret",
      control: { kind: "secret", maxLength: 255 },
      help: "The secret this client is configured with on the server. It signs the request and verifies the reply, so without it there is nothing to check and the monitor says so rather than reporting an outage.",
    },
    {
      name: "username",
      emptyValue: "null",
      label: "User name",
      control: { kind: "text", maxLength: 253 },
      help: "Sent as User-Name. A probe account that is expected to be rejected works as well as one that is accepted; see below.",
    },
    {
      name: "password",
      emptyValue: "null",
      label: "Password",
      control: { kind: "secret", maxLength: 128 },
      help: "Sent as User-Password, encrypted with the shared secret.",
    },
    {
      name: "expectAccept",
      defaultValue: false,
      label: "Require Access-Accept",
      control: { kind: "boolean" },
      help: "Off, and any well-formed signed reply proves the server is answering, which is what most people want to watch, and it needs no real account. On, and only an Access-Accept passes, which also checks the directory behind it.",
    },
    {
      name: "nasIdentifier",
      emptyValue: "null",
      label: "NAS identifier",
      control: { kind: "text", maxLength: 253 },
      help: "Sent as NAS-Identifier. Some servers select a client policy by it.",
      group: "advanced",
    },
  ],
  supportsRecovery: true,
};

/**
 * SIP's registered port, for both UDP and TCP (RFC 3261 §19.1.2). TLS
 * runs on 5061 and is a different transport this type does not speak.
 */
export const DEFAULT_SIP_PORT = 5060;

/** The transports the `sip` type can put an OPTIONS request on. */
export const SIP_TRANSPORTS = ["udp", "tcp"] as const;

export type SipTransport = (typeof SIP_TRANSPORTS)[number];

export const sipDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "sip",
  label: "SIP (OPTIONS)",
  description:
    "Send a SIP OPTIONS request and read the status line that answers it.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "sip.example.com",
    help: "A bare hostname, no scheme, no port. The proxy, registrar or gateway that answers OPTIONS. UDP unless the monitor says otherwise; TLS on 5061 is a transport this check does not speak.",
  },
  port: { required: true, default: DEFAULT_SIP_PORT },
  facts: [
    // `answered` before `statusCode` on purpose: something that replies
    // on 5060 without speaking SIP is a different incident from a
    // registrar that answers 503, and the timeline has to tell them
    // apart even though both read as down.
    { key: "answered", label: "Answered SIP", kind: "boolean" },
    { key: "statusCode", label: "SIP status", kind: "number" },
    { key: "statusText", label: "Reason phrase", kind: "string" },
    { key: "server", label: "Server", kind: "string" },
    // How many requests it took to get an answer. Over UDP this is the
    // retransmission count, which is the only visible evidence of packet
    // loss on a link that is otherwise answering.
    { key: "requestsSent", label: "Requests sent", kind: "number" },
    RESPONSE_TIME,
  ],
  // `expectedStatusCode` is a flat column and a form section that
  // already exists, and a SIP status code is a three-digit code with the
  // same classes as HTTP's. Reusing it means an operator whose gateway
  // answers 405 to OPTIONS can say so in the UI, rather than needing an
  // API call to set a type-specific field.
  form: ["port", "expectedStatusCode"],
  configFields: [
    {
      name: "transport",
      defaultValue: "udp",
      emptyValue: "omit",
      label: "Transport",
      // Values are `SIP_TRANSPORTS`, declared just above this descriptor.
      control: {
        kind: "select",
        options: [
          { value: "udp", label: "UDP" },
          { value: "tcp", label: "TCP" },
        ],
      },
      help: "Which listener the OPTIONS request goes to. UDP 5060 and TCP 5060 are different listeners on most SBCs, so choosing the one the element does not serve times out and reads as down while it is answering perfectly on the other. TLS on 5061 is a transport this check does not speak.",
    },
    {
      name: "requestUser",
      emptyValue: "null",
      label: "Request-URI user",
      control: { kind: "text", placeholder: "pstn", maxLength: 64 },
      help: "Addresses the request to `sip:user@host` instead of the bare `sip:host`. Leave it empty for a proxy or registrar, which is what every one of them answers; set it when the element answers per-AOR, such as a gateway that serves one number and 404s the host itself.",
      group: "advanced",
    },
  ],
  supportsRecovery: true,
};

export const tailscalePingDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "tailscale-ping",
  label: "Tailscale ping",
  description: "Ping a peer inside your tailnet through the Tailscale CLI.",
  target: {
    kind: "label",
    // A label rather than a hostname, and the distinction is real: a
    // MagicDNS name (`db`, `db.tailnet-name.ts.net`) and a 100.x address
    // are resolved by tailscaled, not by DNS, and `monitorHostnameSchema`
    // would refuse the single-label form every tailnet actually uses.
    // The type validates the peer name itself — see
    // `specs/tailscale-ping.ts` — so this is not a weaker check, only a
    // different one.
    label: "Peer",
    placeholder: "db-1",
    help: "A MagicDNS name (`db-1`, `db-1.tailnet-name.ts.net`) or a 100.x tailnet address. Vigil asks the local tailscaled, so the peer never has to be reachable from anywhere else.",
  },
  port: null,
  facts: [
    { key: "outcome", label: "Result", kind: "string" },
    { key: "peer", label: "Peer", kind: "string" },
    { key: "peerAddress", label: "Tailnet address", kind: "string" },
    { key: "via", label: "Path", kind: "string" },
    { key: "direct", label: "Direct connection", kind: "boolean" },
    { key: "responseTimeMs", label: "Round trip", kind: "number", unit: "ms" },
  ],
  form: [],
  configFields: [
    {
      name: "packets",
      emptyValue: "omit",
      label: "Ping attempts",
      control: { kind: "number", min: 1, max: 10, unit: "pings" },
      help: "How many pings one check sends before giving up. The first reply passes, so more attempts ride out a path being renegotiated: a peer that has just changed networks drops the first packet and answers the second. The monitor's timeout is divided between the attempts rather than spent on each, so raising this shortens the wait per attempt.",
      group: "advanced",
    },
    {
      name: "requireDirect",
      defaultValue: false,
      label: "Require a direct path",
      control: { kind: "boolean" },
      help: "Report a peer that is only reachable through a DERP relay as degraded. Leave it off unless direct paths are the norm on your tailnet: plenty of estates never negotiate one, and this would then be amber forever.",
      group: "advanced",
    },
  ],
  // The `tailscale` CLI, and a tailscaled that is logged into a tailnet.
  // Absent — which is every default install — the monitor reads
  // `misconfigured` and says what is missing, never `down`.
  requiresCapability: "tailscale",
  supportsRecovery: true,
};

export const realBrowserDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "real-browser",
  label: "Real browser",
  description:
    "Render a page in a headless browser and assert on what it actually shows.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "https://example.com/app",
    help: "The page to open. It is fetched by a browser, so a single-page app that renders its content in JavaScript is checked as a visitor sees it, not as curl sees it.",
  },
  port: null,
  facts: [
    { key: "rendered", label: "Rendered a document", kind: "boolean" },
    { key: "contentBytes", label: "Document size", kind: "number", unit: "B" },
    { key: "keywordPresent", label: "Keyword found", kind: "boolean" },
    RESPONSE_TIME,
  ],
  // The keyword is the whole point of rendering: the assertion runs on
  // the DOM after scripts have run, which is the difference between this
  // type and `http`. It is a flat column and an existing form section,
  // so an operator can set it without a type-specific field.
  form: ["keyword"],
  configFields: [
    {
      name: "serviceUrl",
      emptyValue: "null",
      label: "Rendering service URL",
      control: {
        kind: "text",
        placeholder: "https://browserless.example.com",
        maxLength: 512,
        mono: true,
      },
      help: "Where the headless browser runs. Vigil does not ship one: without this the monitor reports that it cannot measure rather than guessing.",
    },
    {
      name: "token",
      emptyValue: "null",
      label: "Service token",
      control: { kind: "secret", maxLength: 512 },
      help: "Whatever the rendering service authenticates with. Not trimmed: leading and trailing space are legal in a token.",
    },
    {
      name: "settleMs",
      emptyValue: "omit",
      label: "Settle for (ms)",
      control: { kind: "number", min: 0, max: 10000, step: 100 },
      help: "How long to wait after load before reading the page, for an app that paints its content afterwards. Every millisecond here is added to the check's own latency.",
      group: "advanced",
    },
  ],
  // A browser. Vigil does not ship one — Chromium is a hundred and fifty
  // megabytes and a pile of system libraries — so this type talks to a
  // rendering service over HTTP and reports `misconfigured` when none is
  // configured or reachable.
  requiresCapability: "headless-browser",
  supportsRecovery: true,
};


/**
 * Globalping's own API. Here rather than in the spec because the form's
 * placeholder quotes it, and the form cannot import a spec.
 */
export const GLOBALPING_API_URL = "https://api.globalping.io";

export const globalpingDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "globalping",
  label: "Globalping (worldwide)",
  description:
    "Ping the target from probes around the world through the Globalping API.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "example.com",
    help: "A bare hostname, no scheme, no port. Nothing is dialled from this machine: the measurement is run by Globalping's probe network, so what it reports is what the internet sees rather than what your network sees.",
  },
  port: null,
  facts: [
    { key: "probesTotal", label: "Probes", kind: "number" },
    {
      key: "probesReachable",
      label: "Probes that got a reply",
      kind: "number",
    },
    { key: "packetLossPct", label: "Packet loss", kind: "number", unit: "%" },
    { key: "worstProbe", label: "Worst probe", kind: "string" },
    { key: "resolvedAddress", label: "Resolved to", kind: "string" },
    // The mean round trip the probes measured — not Vigil's own wall
    // clock, which measures the API and says nothing about the target.
    { key: "responseTimeMs", label: "Round trip", kind: "number", unit: "ms" },
    // Vigil's own wall clock, kept as a separate fact rather than
    // discarded: it is how an operator sees that a check is expensive
    // (and why raising the monitor's timeout is the fix) without it ever
    // being mistaken for the target's latency.
    { key: "apiTimeMs", label: "Measurement took", kind: "number", unit: "ms" },
  ],
  // Where the measurement runs from, how many probes and the API token
  // are this type's own config; the monitor form renders no section for
  // them yet, so a monitor created in the UI measures from `world` with
  // three probes and one created by import or API measures what it asked
  // for.
  form: [],
  configFields: [
    {
      name: "location",
      emptyValue: "omit",
      label: "Measure from",
      control: { kind: "text", placeholder: "world", maxLength: 100 },
      help: "Where the measurement runs from, in Globalping's own syntax: `world`, `europe`, `Germany`, `US+NY`, `AS13335`, or a comma-separated list of them. This is half of what the monitor measures: a route that is broken only in São Paulo stays invisible unless you ask for São Paulo.",
    },
    {
      name: "apiToken",
      emptyValue: "null",
      label: "API token",
      control: { kind: "secret", placeholder: "Optional", maxLength: 512 },
      help: "A free Globalping API token. Without one the measurements are anonymous and share an hourly quota with everything else leaving this install's IP address; when that quota is spent the monitor stops measuring rather than reporting the target down.",
    },
    {
      name: "probeLimit",
      emptyValue: "omit",
      label: "Probes",
      control: { kind: "number", min: 1, max: 10, step: 1, unit: "probes" },
      help: "How many probes run each measurement. Every one of them spends quota, and a single probe cannot tell a regional outage from one bad machine.",
      group: "advanced",
    },
    {
      name: "packets",
      emptyValue: "omit",
      label: "Packets per probe",
      control: { kind: "number", min: 1, max: 16, step: 1, unit: "packets" },
      help: "ICMP echoes each probe sends. Fewer makes the loss figure coarser: with one packet, loss is either 0% or 100%.",
      group: "advanced",
    },
    {
      name: "maxPacketLossPct",
      emptyValue: "omit",
      label: "Degraded above",
      control: { kind: "number", min: 0, max: 100, step: 1, unit: "%" },
      help: "Mean packet loss across the probes that counts as degraded. Not zero: internet ICMP loses the odd packet everywhere, so a threshold of zero leaves the monitor permanently amber, which is the same as having no amber at all.",
      group: "advanced",
    },
    {
      name: "apiBaseUrl",
      emptyValue: "omit",
      label: "API base URL",
      control: {
        kind: "text",
        placeholder: GLOBALPING_API_URL,
        maxLength: 512,
        mono: true,
      },
      help: "The Globalping API to call. Change it only to point at a mirror or a self-hosted instance; anything that is not an http or https URL stops the monitor running at all.",
      group: "advanced",
    },
  ],
  requiresCapability: "globalping-api",
  // Deliberately not recoverable. A recovery verification re-probes, and
  // one re-probe here spends three of an hourly quota that is shared by
  // every monitor on this install — a fix that has to be verified from
  // Tokyo is not worth exhausting the budget the scheduled checks run on.
  supportsRecovery: false,
};

/** Every descriptor, in the order the type selector shows them. */
export const CHECK_TYPE_DESCRIPTORS: readonly CheckTypeDescriptor[] = [
  httpDescriptor,
  tcpDescriptor,
  pingDescriptor,
  dnsDescriptor,
  tlsExpiryDescriptor,
  domainExpiryDescriptor,
  postgresDescriptor,
  mysqlDescriptor,
  mongodbDescriptor,
  redisDescriptor,
  dockerDescriptor,
  mqttDescriptor,
  smtpDescriptor,
  jsonQueryDescriptor,
  pushDescriptor,
  groupDescriptor,
  manualDescriptor,
  sqlserverDescriptor,
  oracledbDescriptor,
  memcachedDescriptor,
  elasticsearchDescriptor,
  rabbitmqDescriptor,
  kafkaProducerDescriptor,
  udpDescriptor,
  ntpDescriptor,
  radiusDescriptor,
  imapDescriptor,
  ftpDescriptor,
  ldapDescriptor,
  sshDescriptor,
  websocketDescriptor,
  grpcDescriptor,
  gamedigDescriptor,
  steamDescriptor,
  snmpDescriptor,
  systemServiceDescriptor,
  sipDescriptor,
  tailscalePingDescriptor,
  realBrowserDescriptor,
  globalpingDescriptor,
];

export function findDescriptor(id: string): CheckTypeDescriptor | undefined {
  return CHECK_TYPE_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

/**
 * The descriptor for a stored monitor, tolerating a type this build does
 * not know about. `check_type` is `text` since 1.10.0 precisely so an
 * unknown value is data rather than a failed enum cast — a monitor
 * created by a build with an extra type must still list and still be
 * deletable after a downgrade.
 */
export function describeCheckType(id: string): CheckTypeDescriptor {
  return findDescriptor(id) ?? unknownDescriptor(id);
}

export const CHECK_TYPE_IDS = CHECK_TYPE_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
) as readonly string[];

/**
 * The kind of a stored monitor's type — `active` for one this build
 * does not know, for the reason `unknownDescriptor` gives.
 */
export function checkTypePlane(id: string): "queue" | "synthetic" {
  return describeCheckType(id).executionPlane ?? "queue";
}

/**
 * The kind of a stored monitor's type — `active` for one this build
 * does not know, for the reason `unknownDescriptor` gives.
 */
export function checkTypeKind(id: string): CheckTypeKind {
  return describeCheckType(id).kind;
}

/**
 * Type ids the scheduler must never enqueue.
 *
 * Derived from the catalog rather than written out, so a later
 * aggregate or manual type is excluded by declaring its kind and not by
 * remembering this list exists. Callers put it straight into SQL: the
 * predicate is stated as "not one of these" rather than "one of the
 * scheduled ones", because a monitor whose type this build lost must
 * keep being evaluated (and keep saying so) rather than silently
 * dropping off the scheduler.
 */
export const UNSCHEDULED_CHECK_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter(
    (descriptor) => !isScheduledKind(descriptor.kind),
  ).map((descriptor) => descriptor.id);

/** Type ids that derive their state from other monitors. */
export const AGGREGATE_CHECK_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter(
    (descriptor) => descriptor.kind === "aggregate",
  ).map((descriptor) => descriptor.id);

/**
 * Type ids whose observations do not expire.
 *
 * Every other kind produces evidence that goes stale: a probe result
 * stands for a few intervals and then Vigil admits it no longer knows.
 * An operator's statement is not like that — nothing is going to
 * contradict it except another operator, so expiring it would report
 * "no data" for a monitor that is doing exactly what it was asked to
 * do. See `uptime.ts`, which reads this.
 */
export const STANDING_OBSERVATION_CHECK_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter(
    (descriptor) => descriptor.kind === "manual",
  ).map((descriptor) => descriptor.id);

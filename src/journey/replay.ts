import {
  isSemanticSource,
  isSemanticToken,
  validateSemanticJourneyEventInput,
} from "./catalog.js";
import {
  isEventId,
  isJourneyId,
  isProducerId,
  isSpanId,
  isTraceId,
} from "./context.js";
import type {
  SemanticJourneyCatalog,
  SemanticJourneyEvent,
  SemanticJourneyEventInput,
} from "./types.js";
import { SEMANTIC_JOURNEY_STRICT_POLICY_VERSION } from "./types.js";

/** The confidence level of a deterministic semantic journey reconstruction. */
export type SemanticJourneyCompleteness = "complete" | "partial" | "invalid";

/** A bounded reason why a reconstruction is incomplete or invalid. */
export type SemanticJourneyEvidenceCode =
  | "empty-journey"
  | "invalid-event"
  | "evidence-limit"
  | "missing-parent"
  | "missing-cause"
  | "sequence-gap"
  | "sequence-fork"
  | "cycle"
  | "mixed-journey";

/** Structured, token-only uncertainty attached to a reconstruction. */
export interface SemanticJourneyEvidence {
  readonly code: SemanticJourneyEvidenceCode;
  readonly severity: "partial" | "invalid";
  readonly explanation: string;
  readonly eventId?: string;
  readonly relatedEventId?: string;
  readonly spanId?: string;
  readonly producerId?: string;
  readonly producerSequence?: number;
  readonly expectedSequence?: number;
  readonly observedSequence?: number;
  readonly observedCount?: number;
  readonly eventIds?: readonly string[];
}

/** A privacy-safe event projection used by replay-style inference. */
export interface SemanticJourneyStep {
  readonly eventId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly causedByEventId?: string;
  readonly producerId: string;
  readonly producerSequence: number;
  readonly occurredAtEpochMs: number;
  readonly source: string;
  readonly channel: SemanticJourneyEvent["channel"];
  readonly runtime: SemanticJourneyEvent["runtime"];
  readonly name: string;
  readonly category: SemanticJourneyEvent["category"];
  readonly phase: SemanticJourneyEvent["phase"];
  readonly outcome: SemanticJourneyEvent["outcome"];
  readonly modality?: NonNullable<SemanticJourneyEvent["modality"]>;
  readonly target?: {
    readonly type: string;
    readonly id: string;
  };
  readonly predecessorEventIds: readonly string[];
  readonly explanation: string;
}

/** A deterministic reconstruction of exactly one semantic journey. */
export interface SemanticJourneyReplay {
  readonly journeyId?: string;
  readonly completeness: SemanticJourneyCompleteness;
  readonly steps: readonly SemanticJourneyStep[];
  readonly evidence: readonly SemanticJourneyEvidence[];
}

interface EventNode {
  readonly event: SemanticJourneyEvent;
  readonly predecessors: Set<string>;
  readonly successors: Set<string>;
}

interface CausalComponent {
  readonly index: number;
  readonly nodes: readonly EventNode[];
  readonly predecessors: Set<number>;
  readonly successors: Set<number>;
}

interface GraphLimits {
  edgeCount: number;
}

type EvidenceDetails = Omit<
  SemanticJourneyEvidence,
  "code" | "severity" | "explanation"
>;

type DataRecord = Record<string, unknown>;

const MAX_EVENTS = 5_000;
const MAX_GROUP_NODES = 32;
const MAX_EVENT_ATTRIBUTES = 32;
const MAX_CATALOG_SOURCES = 64;
const MAX_GRAPH_EDGES = 250_000;
const MAX_EVIDENCE_ITEMS = 5_000;
const MAX_EVIDENCE_EVENT_IDS = 32;

const EVENT_REQUIRED_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "journeyId",
  "traceId",
  "spanId",
  "producerId",
  "producerSequence",
  "occurredAtEpochMs",
  "source",
  "channel",
  "runtime",
  "name",
  "category",
  "phase",
  "outcome",
  "attributes",
  "privacy",
]);
const EVENT_FIELDS = new Set([
  ...EVENT_REQUIRED_FIELDS,
  "parentSpanId",
  "causedByEventId",
  "modality",
  "target",
]);
const TARGET_FIELDS = new Set(["type", "id"]);
const PRIVACY_FIELDS = new Set([
  "mode",
  "policyVersion",
  "droppedAttributeCount",
]);
const CATALOG_FIELDS = new Set(["sources", "definitions"]);

const EVIDENCE_EXPLANATIONS: Record<SemanticJourneyEvidenceCode, string> = {
  "empty-journey": "No semantic journey evidence was supplied",
  "invalid-event": "Semantic journey evidence failed strict validation",
  "evidence-limit": "Semantic journey evidence exceeded a safety limit",
  "missing-parent": "Parent span evidence is missing",
  "missing-cause": "Caused-by event evidence is missing",
  "sequence-gap": "Producer sequence evidence has a gap",
  "sequence-fork": "Producer sequence evidence has a fork",
  cycle: "Causal evidence contains a cycle",
  "mixed-journey": "Evidence contains more than one journey",
};

const INVALID_EVIDENCE_CODES = new Set<SemanticJourneyEvidenceCode>([
  "empty-journey",
  "invalid-event",
  "evidence-limit",
  "cycle",
  "mixed-journey",
]);

const PHASE_RANK: Record<SemanticJourneyEvent["phase"], number> = {
  intent: 0,
  start: 1,
  progress: 2,
  effect: 3,
  end: 4,
};

class InvalidRuntimeEvidenceError extends Error {}

class EvidenceLimitError extends Error {}

function invalidRuntimeEvidence(): never {
  throw new InvalidRuntimeEvidenceError();
}

function evidenceLimit(): never {
  throw new EvidenceLimitError();
}

function compareTokens(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareOptionalTokens(
  left: string | undefined,
  right: string | undefined
): number {
  return compareTokens(left ?? "", right ?? "");
}

function compareEventsForOrder(
  left: SemanticJourneyEvent,
  right: SemanticJourneyEvent
): number {
  const timestampComparison = left.occurredAtEpochMs - right.occurredAtEpochMs;
  return timestampComparison || compareTokens(left.eventId, right.eventId);
}

function compareNodes(left: EventNode, right: EventNode): number {
  return compareEventsForOrder(left.event, right.event);
}

function evidence(
  code: SemanticJourneyEvidenceCode,
  details: EvidenceDetails = {}
): SemanticJourneyEvidence {
  return {
    code,
    severity: INVALID_EVIDENCE_CODES.has(code) ? "invalid" : "partial",
    explanation: EVIDENCE_EXPLANATIONS[code],
    ...details,
  };
}

function invalidReplay(
  code: "invalid-event" | "evidence-limit"
): SemanticJourneyReplay {
  return {
    completeness: "invalid",
    steps: [],
    evidence: [evidence(code)],
  };
}

function appendEvidence(
  items: SemanticJourneyEvidence[],
  item: SemanticJourneyEvidence
): void {
  if (items.length >= MAX_EVIDENCE_ITEMS) {
    evidenceLimit();
  }
  items.push(item);
}

function compareEvidence(
  left: SemanticJourneyEvidence,
  right: SemanticJourneyEvidence
): number {
  const codeComparison = compareTokens(left.code, right.code);
  if (codeComparison !== 0) {
    return codeComparison;
  }

  const tokenComparisons = [
    compareOptionalTokens(left.eventId, right.eventId),
    compareOptionalTokens(left.relatedEventId, right.relatedEventId),
    compareOptionalTokens(left.spanId, right.spanId),
    compareOptionalTokens(left.producerId, right.producerId),
    compareTokens(
      left.eventIds?.join(":") ?? "",
      right.eventIds?.join(":") ?? ""
    ),
  ];
  const tokenComparison =
    tokenComparisons.find((comparison) => comparison !== 0) ?? 0;
  if (tokenComparison !== 0) {
    return tokenComparison;
  }

  const numericFields: Array<keyof Pick<
    SemanticJourneyEvidence,
    | "producerSequence"
    | "expectedSequence"
    | "observedSequence"
    | "observedCount"
  >> = [
    "producerSequence",
    "expectedSequence",
    "observedSequence",
    "observedCount",
  ];
  for (const field of numericFields) {
    const comparison = (left[field] ?? -1) - (right[field] ?? -1);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataRecord(
  value: unknown,
  allowedFields?: ReadonlySet<string>,
  requiredFields: ReadonlySet<string> = new Set(),
  maximumFields = Number.MAX_SAFE_INTEGER
): DataRecord {
  if (!isPlainRecord(value)) {
    return invalidRuntimeEvidence();
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length > maximumFields ||
    keys.some((key) => typeof key !== "string")
  ) {
    return invalidRuntimeEvidence();
  }
  const stringKeys = keys as string[];
  if (
    (allowedFields && stringKeys.some((key) => !allowedFields.has(key))) ||
    [...requiredFields].some((field) => !stringKeys.includes(field))
  ) {
    return invalidRuntimeEvidence();
  }

  const result: DataRecord = Object.create(null) as DataRecord;
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidRuntimeEvidence();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readDataArray(
  value: unknown,
  maximumItems: number
): readonly unknown[] {
  if (!Array.isArray(value)) {
    return invalidRuntimeEvidence();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return invalidRuntimeEvidence();
  }
  if (lengthDescriptor.value > maximumItems) {
    return evidenceLimit();
  }

  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidRuntimeEvidence();
    }
    result.push(descriptor.value);
  }
  return result;
}

function readAllowedSources(catalogue: SemanticJourneyCatalog): ReadonlySet<string> {
  const catalogRecord = readDataRecord(
    catalogue,
    CATALOG_FIELDS,
    CATALOG_FIELDS,
    CATALOG_FIELDS.size
  );
  const sourceValues = readDataArray(
    catalogRecord.sources,
    MAX_CATALOG_SOURCES
  );
  if (sourceValues.length === 0) {
    return invalidRuntimeEvidence();
  }

  const sources = new Set<string>();
  for (const source of sourceValues) {
    if (!isSemanticSource(source) || sources.has(source)) {
      return invalidRuntimeEvidence();
    }
    sources.add(source);
  }
  return sources;
}

function isValidChannelRuntime(
  channel: unknown,
  runtime: unknown
): channel is SemanticJourneyEvent["channel"] {
  return (
    (channel === "frontend" && runtime === "browser") ||
    (channel === "backend" && runtime === "server")
  );
}

function readOptionalIdentifier(
  value: unknown,
  validator: (candidate: unknown) => candidate is string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validator(value) ? value : invalidRuntimeEvidence();
}

function normalizeRuntimeEvent(
  catalogue: SemanticJourneyCatalog,
  allowedSources: ReadonlySet<string>,
  candidate: unknown
): SemanticJourneyEvent {
  const record = readDataRecord(
    candidate,
    EVENT_FIELDS,
    EVENT_REQUIRED_FIELDS,
    EVENT_FIELDS.size
  );
  if (
    record.schemaVersion !== "2.0" ||
    !isEventId(record.eventId) ||
    !isJourneyId(record.journeyId) ||
    !isTraceId(record.traceId) ||
    !isSpanId(record.spanId) ||
    !isProducerId(record.producerId) ||
    !Number.isSafeInteger(record.producerSequence) ||
    (record.producerSequence as number) < 1 ||
    !Number.isSafeInteger(record.occurredAtEpochMs) ||
    (record.occurredAtEpochMs as number) < 0 ||
    !isSemanticSource(record.source) ||
    !allowedSources.has(record.source) ||
    !isValidChannelRuntime(record.channel, record.runtime)
  ) {
    return invalidRuntimeEvidence();
  }

  const parentSpanId = readOptionalIdentifier(record.parentSpanId, isSpanId);
  const causedByEventId = readOptionalIdentifier(
    record.causedByEventId,
    isEventId
  );
  const attributes = readDataRecord(
    record.attributes,
    undefined,
    new Set(),
    MAX_EVENT_ATTRIBUTES
  );
  const privacy = readDataRecord(
    record.privacy,
    PRIVACY_FIELDS,
    PRIVACY_FIELDS,
    PRIVACY_FIELDS.size
  );
  if (
    privacy.mode !== "strict" ||
    privacy.policyVersion !== SEMANTIC_JOURNEY_STRICT_POLICY_VERSION ||
    privacy.droppedAttributeCount !== 0
  ) {
    return invalidRuntimeEvidence();
  }

  let target: SemanticJourneyEventInput["target"];
  if (record.target !== undefined) {
    const targetRecord = readDataRecord(
      record.target,
      TARGET_FIELDS,
      TARGET_FIELDS,
      TARGET_FIELDS.size
    );
    if (
      !isSemanticToken(targetRecord.type) ||
      !isSemanticToken(targetRecord.id)
    ) {
      return invalidRuntimeEvidence();
    }
    target = { type: targetRecord.type, id: targetRecord.id };
  }

  const input = {
    name: record.name,
    category: record.category,
    phase: record.phase,
    outcome: record.outcome,
    ...(record.modality === undefined ? {} : { modality: record.modality }),
    ...(target === undefined ? {} : { target }),
    attributes,
  } as SemanticJourneyEventInput;
  const validated = validateSemanticJourneyEventInput(catalogue, input);

  return Object.freeze({
    schemaVersion: "2.0",
    eventId: record.eventId,
    journeyId: record.journeyId,
    traceId: record.traceId,
    spanId: record.spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(causedByEventId === undefined ? {} : { causedByEventId }),
    producerId: record.producerId,
    producerSequence: record.producerSequence as number,
    occurredAtEpochMs: record.occurredAtEpochMs as number,
    source: record.source,
    channel: record.channel,
    runtime: record.runtime as SemanticJourneyEvent["runtime"],
    name: validated.name,
    category: validated.category,
    phase: validated.phase,
    outcome: validated.outcome,
    ...(validated.modality === undefined
      ? {}
      : { modality: validated.modality }),
    ...(validated.target === undefined ? {} : { target: validated.target }),
    attributes: Object.freeze({ ...validated.attributes }),
    privacy: Object.freeze({
      mode: "strict",
      policyVersion: privacy.policyVersion,
      droppedAttributeCount: 0,
    }),
  });
}

function attributesEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>
): boolean {
  const leftKeys = Object.keys(left).sort(compareTokens);
  const rightKeys = Object.keys(right).sort(compareTokens);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && Object.is(left[key], right[key])
    )
  );
}

function eventsEqual(
  left: SemanticJourneyEvent,
  right: SemanticJourneyEvent
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.eventId === right.eventId &&
    left.journeyId === right.journeyId &&
    left.traceId === right.traceId &&
    left.spanId === right.spanId &&
    left.parentSpanId === right.parentSpanId &&
    left.causedByEventId === right.causedByEventId &&
    left.producerId === right.producerId &&
    left.producerSequence === right.producerSequence &&
    left.occurredAtEpochMs === right.occurredAtEpochMs &&
    left.source === right.source &&
    left.channel === right.channel &&
    left.runtime === right.runtime &&
    left.name === right.name &&
    left.category === right.category &&
    left.phase === right.phase &&
    left.outcome === right.outcome &&
    left.modality === right.modality &&
    left.target?.type === right.target?.type &&
    left.target?.id === right.target?.id &&
    left.privacy.mode === right.privacy.mode &&
    left.privacy.policyVersion === right.privacy.policyVersion &&
    left.privacy.droppedAttributeCount === right.privacy.droppedAttributeCount &&
    attributesEqual(left.attributes, right.attributes)
  );
}

function deduplicateEvents(
  events: readonly SemanticJourneyEvent[]
): SemanticJourneyEvent[] {
  const byEventId = new Map<string, SemanticJourneyEvent>();
  for (const event of events) {
    const existing = byEventId.get(event.eventId);
    if (existing && !eventsEqual(existing, event)) {
      return invalidRuntimeEvidence();
    }
    byEventId.set(event.eventId, existing ?? event);
  }
  return [...byEventId.values()].sort(compareEventsForOrder);
}

function addEdge(
  from: EventNode,
  to: EventNode,
  limits: GraphLimits
): void {
  if (from.successors.has(to.event.eventId)) {
    return;
  }
  if (limits.edgeCount >= MAX_GRAPH_EDGES) {
    evidenceLimit();
  }
  limits.edgeCount += 1;
  from.successors.add(to.event.eventId);
  to.predecessors.add(from.event.eventId);
}

function addBoundedNode(
  group: EventNode[],
  node: EventNode
): void {
  if (group.length >= MAX_GROUP_NODES) {
    evidenceLimit();
  }
  group.push(node);
}

function compareSpanAnchors(left: EventNode, right: EventNode): number {
  const phaseComparison =
    PHASE_RANK[left.event.phase] - PHASE_RANK[right.event.phase];
  return phaseComparison || compareNodes(left, right);
}

function buildReferenceEdges(
  nodes: readonly EventNode[],
  nodesByEventId: ReadonlyMap<string, EventNode>,
  reconstructionEvidence: SemanticJourneyEvidence[],
  limits: GraphLimits
): void {
  const spansByTrace = new Map<string, Map<string, EventNode[]>>();
  for (const node of nodes) {
    let spans = spansByTrace.get(node.event.traceId);
    if (!spans) {
      spans = new Map<string, EventNode[]>();
      spansByTrace.set(node.event.traceId, spans);
    }
    const spanNodes = spans.get(node.event.spanId) ?? [];
    addBoundedNode(spanNodes, node);
    spans.set(node.event.spanId, spanNodes);
  }

  for (const node of nodes) {
    const { event } = node;
    if (event.causedByEventId) {
      const cause = nodesByEventId.get(event.causedByEventId);
      if (cause) {
        addEdge(cause, node, limits);
      } else {
        appendEvidence(
          reconstructionEvidence,
          evidence("missing-cause", {
            eventId: event.eventId,
            relatedEventId: event.causedByEventId,
          })
        );
      }
    }

    if (!event.parentSpanId) {
      continue;
    }
    if (event.parentSpanId === event.spanId) {
      addEdge(node, node, limits);
      continue;
    }

    const parentCandidates = spansByTrace
      .get(event.traceId)
      ?.get(event.parentSpanId);
    if (!parentCandidates || parentCandidates.length === 0) {
      appendEvidence(
        reconstructionEvidence,
        evidence("missing-parent", {
          eventId: event.eventId,
          spanId: event.parentSpanId,
        })
      );
      continue;
    }
    const parent = [...parentCandidates].sort(compareSpanAnchors)[0];
    if (parent) {
      addEdge(parent, node, limits);
    }
  }
}

function sortedEventIds(nodes: readonly EventNode[]): string[] {
  if (nodes.length > MAX_EVIDENCE_EVENT_IDS) {
    return evidenceLimit();
  }
  return nodes.map((node) => node.event.eventId).sort(compareTokens);
}

function buildProducerEdges(
  nodes: readonly EventNode[],
  reconstructionEvidence: SemanticJourneyEvidence[],
  limits: GraphLimits
): void {
  const producers = new Map<string, Map<number, EventNode[]>>();
  for (const node of nodes) {
    let sequences = producers.get(node.event.producerId);
    if (!sequences) {
      sequences = new Map<number, EventNode[]>();
      producers.set(node.event.producerId, sequences);
    }
    const sequenceNodes = sequences.get(node.event.producerSequence) ?? [];
    addBoundedNode(sequenceNodes, node);
    sequences.set(node.event.producerSequence, sequenceNodes);
  }

  const producerEntries = [...producers.entries()].sort(([left], [right]) =>
    compareTokens(left, right)
  );
  for (const [producerId, sequences] of producerEntries) {
    const sequenceEntries = [...sequences.entries()].sort(
      ([left], [right]) => left - right
    );
    const firstSequence = sequenceEntries[0]?.[0];
    if (firstSequence !== undefined && firstSequence > 1) {
      appendEvidence(
        reconstructionEvidence,
        evidence("sequence-gap", {
          producerId,
          expectedSequence: 1,
          observedSequence: firstSequence,
        })
      );
    }

    for (const [sequence, sequenceNodes] of sequenceEntries) {
      if (sequenceNodes.length > 1) {
        appendEvidence(
          reconstructionEvidence,
          evidence("sequence-fork", {
            producerId,
            producerSequence: sequence,
            eventIds: sortedEventIds(sequenceNodes),
          })
        );
      }
    }

    for (let index = 1; index < sequenceEntries.length; index += 1) {
      const previousEntry = sequenceEntries[index - 1];
      const currentEntry = sequenceEntries[index];
      if (!previousEntry || !currentEntry) {
        continue;
      }
      const [previousSequence, previousNodes] = previousEntry;
      const [currentSequence, currentNodes] = currentEntry;
      if (currentSequence > previousSequence + 1) {
        appendEvidence(
          reconstructionEvidence,
          evidence("sequence-gap", {
            producerId,
            expectedSequence: previousSequence + 1,
            observedSequence: currentSequence,
          })
        );
      }
      for (const previous of previousNodes) {
        for (const current of currentNodes) {
          addEdge(previous, current, limits);
        }
      }
    }
  }
}

function adjacency(
  identifiers: ReadonlySet<string>,
  nodesByEventId: ReadonlyMap<string, EventNode>
): EventNode[] {
  const result: EventNode[] = [];
  for (const identifier of identifiers) {
    const node = nodesByEventId.get(identifier);
    if (!node) {
      return invalidRuntimeEvidence();
    }
    result.push(node);
  }
  return result.sort(compareNodes);
}

function stronglyConnectedComponents(
  nodes: readonly EventNode[],
  nodesByEventId: ReadonlyMap<string, EventNode>
): CausalComponent[] {
  const successors = new Map(
    nodes.map((node) => [
      node.event.eventId,
      adjacency(node.successors, nodesByEventId),
    ])
  );
  const predecessors = new Map(
    nodes.map((node) => [
      node.event.eventId,
      adjacency(node.predecessors, nodesByEventId),
    ])
  );

  const finished: EventNode[] = [];
  const visited = new Set<string>();
  for (const root of [...nodes].sort(compareNodes)) {
    if (visited.has(root.event.eventId)) {
      continue;
    }
    visited.add(root.event.eventId);
    const stack: Array<{
      readonly node: EventNode;
      readonly adjacent: readonly EventNode[];
      next: number;
    }> = [
      {
        node: root,
        adjacent: successors.get(root.event.eventId) ?? [],
        next: 0,
      },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) {
        return invalidRuntimeEvidence();
      }
      const next = frame.adjacent[frame.next];
      if (next) {
        frame.next += 1;
        if (!visited.has(next.event.eventId)) {
          visited.add(next.event.eventId);
          stack.push({
            node: next,
            adjacent: successors.get(next.event.eventId) ?? [],
            next: 0,
          });
        }
      } else {
        finished.push(frame.node);
        stack.pop();
      }
    }
  }

  const assigned = new Set<string>();
  const componentNodes: EventNode[][] = [];
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const root = finished[index];
    if (!root || assigned.has(root.event.eventId)) {
      continue;
    }
    const members: EventNode[] = [];
    const stack = [root];
    assigned.add(root.event.eventId);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        return invalidRuntimeEvidence();
      }
      members.push(current);
      const adjacentNodes = predecessors.get(current.event.eventId) ?? [];
      for (let adjacentIndex = adjacentNodes.length - 1; adjacentIndex >= 0; adjacentIndex -= 1) {
        const predecessor = adjacentNodes[adjacentIndex];
        if (predecessor && !assigned.has(predecessor.event.eventId)) {
          assigned.add(predecessor.event.eventId);
          stack.push(predecessor);
        }
      }
    }
    componentNodes.push(members.sort(compareNodes));
  }

  const componentByEventId = new Map<string, number>();
  componentNodes.forEach((members, componentIndex) => {
    for (const member of members) {
      componentByEventId.set(member.event.eventId, componentIndex);
    }
  });
  const components = componentNodes.map<CausalComponent>((members, index) => ({
    index,
    nodes: members,
    predecessors: new Set<number>(),
    successors: new Set<number>(),
  }));

  for (const node of nodes) {
    const fromIndex = componentByEventId.get(node.event.eventId);
    if (fromIndex === undefined) {
      return invalidRuntimeEvidence();
    }
    for (const successorId of node.successors) {
      const toIndex = componentByEventId.get(successorId);
      if (toIndex === undefined) {
        return invalidRuntimeEvidence();
      }
      if (fromIndex !== toIndex) {
        components[fromIndex]?.successors.add(toIndex);
        components[toIndex]?.predecessors.add(fromIndex);
      }
    }
  }
  return components;
}

function compareComponents(
  left: CausalComponent,
  right: CausalComponent
): number {
  const leftAnchor = left.nodes[0];
  const rightAnchor = right.nodes[0];
  if (!leftAnchor || !rightAnchor) {
    return left.index - right.index;
  }
  return compareNodes(leftAnchor, rightAnchor) || left.index - right.index;
}

function condensedCausalOrder(components: readonly CausalComponent[]): EventNode[] {
  const indegrees = new Map(
    components.map((component) => [
      component.index,
      component.predecessors.size,
    ])
  );
  const ready = components
    .filter((component) => component.predecessors.size === 0)
    .sort(compareComponents);
  const ordered: EventNode[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) {
      return invalidRuntimeEvidence();
    }
    ordered.push(...current.nodes);
    const successors = [...current.successors]
      .map((index) => components[index])
      .filter((component): component is CausalComponent => component !== undefined)
      .sort(compareComponents);
    for (const successor of successors) {
      const remaining = (indegrees.get(successor.index) ?? 0) - 1;
      indegrees.set(successor.index, remaining);
      if (remaining === 0) {
        ready.push(successor);
      }
    }
    ready.sort(compareComponents);
  }

  if (ordered.length !== components.reduce((count, item) => count + item.nodes.length, 0)) {
    return invalidRuntimeEvidence();
  }
  return ordered;
}

function addCycleEvidence(
  components: readonly CausalComponent[],
  reconstructionEvidence: SemanticJourneyEvidence[]
): void {
  for (const component of components) {
    const first = component.nodes[0];
    const isCycle =
      component.nodes.length > 1 ||
      (first !== undefined && first.successors.has(first.event.eventId));
    if (isCycle) {
      appendEvidence(
        reconstructionEvidence,
        evidence("cycle", { eventIds: sortedEventIds(component.nodes) })
      );
    }
  }
}

function semanticToken(value: string): string {
  return isSemanticToken(value) ? value : "unknown";
}

function genericExplanation(event: SemanticJourneyEvent): string {
  const tokens = [
    event.channel,
    event.category,
    semanticToken(event.name),
    event.phase,
  ];
  if (event.modality) {
    tokens.push("by", event.modality);
  }
  if (event.target) {
    tokens.push(
      "target",
      semanticToken(event.target.type),
      semanticToken(event.target.id)
    );
  }
  tokens.push("outcome", event.outcome);
  return tokens.join(" ");
}

function toStep(node: EventNode): SemanticJourneyStep {
  const { event } = node;
  return {
    eventId: event.eventId,
    traceId: event.traceId,
    spanId: event.spanId,
    ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
    ...(event.causedByEventId
      ? { causedByEventId: event.causedByEventId }
      : {}),
    producerId: event.producerId,
    producerSequence: event.producerSequence,
    occurredAtEpochMs: event.occurredAtEpochMs,
    source: semanticToken(event.source),
    channel: event.channel,
    runtime: event.runtime,
    name: semanticToken(event.name),
    category: event.category,
    phase: event.phase,
    outcome: event.outcome,
    ...(event.modality ? { modality: event.modality } : {}),
    ...(event.target
      ? {
          target: {
            type: semanticToken(event.target.type),
            id: semanticToken(event.target.id),
          },
        }
      : {}),
    predecessorEventIds: [...node.predecessors].sort(compareTokens),
    explanation: genericExplanation(event),
  };
}

function completenessFromEvidence(
  reconstructionEvidence: readonly SemanticJourneyEvidence[]
): SemanticJourneyCompleteness {
  if (reconstructionEvidence.some((item) => item.severity === "invalid")) {
    return "invalid";
  }
  return reconstructionEvidence.length > 0 ? "partial" : "complete";
}

function reconstructSemanticJourneyUnsafe(
  catalogue: SemanticJourneyCatalog,
  events: readonly SemanticJourneyEvent[]
): SemanticJourneyReplay {
  const allowedSources = readAllowedSources(catalogue);
  const candidates = readDataArray(events, MAX_EVENTS);
  if (candidates.length === 0) {
    return {
      completeness: "invalid",
      steps: [],
      evidence: [evidence("empty-journey", { observedCount: 0 })],
    };
  }

  const normalized = candidates.map((candidate) =>
    normalizeRuntimeEvent(catalogue, allowedSources, candidate)
  );
  const journeyIds = new Set(normalized.map((event) => event.journeyId));
  if (journeyIds.size !== 1) {
    return {
      completeness: "invalid",
      steps: [],
      evidence: [
        evidence("mixed-journey", {
          observedCount: journeyIds.size,
        }),
      ],
    };
  }

  const deduplicatedEvents = deduplicateEvents(normalized);
  const nodes = deduplicatedEvents.map<EventNode>((event) => ({
    event,
    predecessors: new Set<string>(),
    successors: new Set<string>(),
  }));
  const nodesByEventId = new Map(
    nodes.map((node) => [node.event.eventId, node])
  );
  const reconstructionEvidence: SemanticJourneyEvidence[] = [];
  const limits: GraphLimits = { edgeCount: 0 };

  buildReferenceEdges(
    nodes,
    nodesByEventId,
    reconstructionEvidence,
    limits
  );
  buildProducerEdges(nodes, reconstructionEvidence, limits);
  const components = stronglyConnectedComponents(nodes, nodesByEventId);
  addCycleEvidence(components, reconstructionEvidence);
  const ordered = condensedCausalOrder(components);
  reconstructionEvidence.sort(compareEvidence);

  const journeyId = normalized[0]?.journeyId;
  if (!journeyId) {
    return invalidRuntimeEvidence();
  }
  return {
    journeyId,
    completeness: completenessFromEvidence(reconstructionEvidence),
    steps: ordered.map(toStep),
    evidence: reconstructionEvidence,
  };
}

/**
 * Reconstructs one strictly validated semantic journey without copying event
 * attributes. Causal references and producer order take precedence over
 * timestamps, which are used only as deterministic topological tie-breakers.
 * Any runtime-invalid event or exceeded work bound fails closed.
 */
export function reconstructSemanticJourney(
  catalogue: SemanticJourneyCatalog,
  events: readonly SemanticJourneyEvent[]
): SemanticJourneyReplay {
  try {
    return reconstructSemanticJourneyUnsafe(catalogue, events);
  } catch (error) {
    return error instanceof EvidenceLimitError
      ? invalidReplay("evidence-limit")
      : invalidReplay("invalid-event");
  }
}

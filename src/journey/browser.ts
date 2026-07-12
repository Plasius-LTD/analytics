import {
  getJourneyEventDefinition,
  isJourneyToken,
  validateSemanticJourneyEventInput,
  type SemanticJourneyCatalogue,
} from "./catalog.js";
import type { SemanticJourneyEventInput } from "./types.js";

const EVENT_ATTRIBUTE = "data-plasius-event";
const TARGET_TYPE_ATTRIBUTE = "data-plasius-target-type";
const TARGET_ID_ATTRIBUTE = "data-plasius-target-id";

const OBSERVED_EVENT_TYPES = [
  "click",
  "submit",
  "change",
  "toggle",
  "play",
  "pause",
  "ended",
  "drop",
] as const;

type ObservedEventType = (typeof OBSERVED_EVENT_TYPES)[number];
type EventPhase = SemanticJourneyEventInput["phase"];
type EventOutcome = SemanticJourneyEventInput["outcome"];

interface BrowserEventSemantics {
  readonly phase: EventPhase;
  readonly outcome: EventOutcome;
}

const EVENT_SEMANTICS: Readonly<Record<ObservedEventType, BrowserEventSemantics>> = {
  click: { phase: "intent", outcome: "unknown" },
  submit: { phase: "intent", outcome: "unknown" },
  change: { phase: "effect", outcome: "success" },
  toggle: { phase: "effect", outcome: "success" },
  play: { phase: "start", outcome: "unknown" },
  pause: { phase: "progress", outcome: "success" },
  ended: { phase: "end", outcome: "success" },
  drop: { phase: "effect", outcome: "success" },
};

/** Configuration for explicit, delegated browser semantic observation. */
export interface SemanticJourneyBrowserObserverConfig {
  /** The registered, bounded event catalogue used to admit semantic names. */
  readonly catalogue: SemanticJourneyCatalogue;
  /** Receives a safe semantic input; callback failures never affect the page. */
  readonly onEvent: (event: SemanticJourneyEventInput) => void;
  /** Delegation root. Defaults to the current document in browser runtimes. */
  readonly root?: Document | Element;
  /** Allows a remotely resolved rollout decision to disable all listeners. */
  readonly enabled: boolean;
}

interface AnnotatedElement {
  readonly element: Element;
  readonly eventName: string;
}

function isElement(value: EventTarget | undefined): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function findAnnotatedElement(
  event: Event,
  root: Document | Element
): AnnotatedElement | undefined {
  const path = typeof event.composedPath === "function"
    ? event.composedPath()
    : [event.target].filter((candidate): candidate is EventTarget => candidate !== null);

  for (const candidate of path) {
    if (isElement(candidate)) {
      const eventName = candidate.getAttribute(EVENT_ATTRIBUTE);
      if (eventName !== null) {
        return { element: candidate, eventName };
      }
    }

    if (candidate === root) {
      break;
    }
  }

  return undefined;
}

function readTarget(
  element: Element
): SemanticJourneyEventInput["target"] | null {
  const type = element.getAttribute(TARGET_TYPE_ATTRIBUTE);
  const id = element.getAttribute(TARGET_ID_ATTRIBUTE);

  if (type === null && id === null) {
    return undefined;
  }
  if (
    type === null
    || id === null
    || !isJourneyToken(type)
    || !isJourneyToken(id)
  ) {
    return null;
  }

  return { type, id };
}

function inferClickModality(event: Event): SemanticJourneyEventInput["modality"] {
  if (event.type !== "click" || typeof MouseEvent === "undefined" || !(event instanceof MouseEvent)) {
    return undefined;
  }

  if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent) {
    return event.pointerType === "touch" ? "touch" : "pointer";
  }

  // UIEvent.detail is zero for keyboard-generated activations. No key value is
  // observed or retained, and the click count itself never enters the event.
  return event.detail === 0 ? "keyboard" : "pointer";
}

function isObservedEventType(value: string): value is ObservedEventType {
  return Object.hasOwn(EVENT_SEMANTICS, value);
}

/**
 * Installs delegated semantic interaction listeners on one root.
 *
 * Only explicit `data-plasius-event`, `data-plasius-target-type`, and
 * `data-plasius-target-id` annotations are inspected. DOM content, form values,
 * URLs, low-level input data, and arbitrary attributes are never read.
 *
 * @returns A function that removes every installed listener.
 */
export function observeSemanticJourneyInteractions(
  config: SemanticJourneyBrowserObserverConfig
): () => void {
  if (config.enabled !== true) {
    return () => undefined;
  }

  const root = config.root
    ?? (typeof document === "undefined" ? undefined : document);
  if (!root) {
    return () => undefined;
  }

  const handleEvent = (event: Event): void => {
    if (!isObservedEventType(event.type)) {
      return;
    }

    const annotated = findAnnotatedElement(event, root);
    if (!annotated || !isJourneyToken(annotated.eventName)) {
      return;
    }

    const definition = getJourneyEventDefinition(config.catalogue, annotated.eventName);
    if (!definition) {
      return;
    }

    const semantics = EVENT_SEMANTICS[event.type];
    const target = readTarget(annotated.element);
    if (target === null) {
      return;
    }
    const modality = inferClickModality(event);
    const input: SemanticJourneyEventInput = {
      name: annotated.eventName,
      category: definition.category,
      phase: semantics.phase,
      outcome: semantics.outcome,
      ...(target ? { target } : {}),
      ...(modality ? { modality } : {}),
    };

    try {
      validateSemanticJourneyEventInput(config.catalogue, input);
      config.onEvent(input);
    } catch {
      // Observability must not alter application event delivery.
    }
  };

  for (const eventType of OBSERVED_EVENT_TYPES) {
    // Capture preserves delegation for media and toggle events that do not
    // consistently bubble across supported browsers.
    root.addEventListener(eventType, handleEvent, true);
  }

  return () => {
    for (const eventType of OBSERVED_EVENT_TYPES) {
      root.removeEventListener(eventType, handleEvent, true);
    }
  };
}

import { SpanStatus } from '@opentelemetry/api';
import { collectorTypes } from '@opentelemetry/exporter-collector';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

import {
  DataFrame,
  DataQueryResponse,
  DataSourceInstanceSettings,
  FieldType,
  MutableDataFrame,
  TraceKeyValuePair,
  TraceLog,
  TraceSpanReference,
  TraceSpanRow,
  FieldDTO,
  createDataFrame,
  getDisplayProcessor,
  createTheme,
} from '@grafana/data';

import { createGraphFrames } from './graphTransform';
import { Span, SpanAttributes, Spanset, TraceSearchMetadata } from './types';

export function createTableFrame(
  logsFrame: DataFrame,
  datasourceUid: string,
  datasourceName: string,
  traceRegexs: string[]
): DataFrame {
  const tableFrame = new MutableDataFrame({
    fields: [
      {
        name: 'Time',
        type: FieldType.time,
        config: {
          custom: {
            width: 200,
          },
        },
      },
      {
        name: 'traceID',
        type: FieldType.string,
        config: {
          displayNameFromDS: 'Trace ID',
          custom: { width: 180 },
          links: [
            {
              title: 'Click to open trace ${__value.raw}',
              url: '',
              internal: {
                datasourceUid,
                datasourceName,
                query: {
                  query: '${__value.raw}',
                },
              },
            },
          ],
        },
      },
      {
        name: 'Message',
        type: FieldType.string,
      },
    ],
    meta: {
      preferredVisualisationType: 'table',
    },
  });

  if (!logsFrame || traceRegexs.length === 0) {
    return tableFrame;
  }

  const timeField = logsFrame.fields.find((f) => f.type === FieldType.time);

  // Going through all string fields to look for trace IDs
  for (let field of logsFrame.fields) {
    let hasMatch = false;
    if (field.type === FieldType.string) {
      const values = field.values;
      for (let i = 0; i < values.length; i++) {
        const line = values[i];
        if (line) {
          for (let traceRegex of traceRegexs) {
            const match = (line as string).match(traceRegex);
            if (match) {
              const traceId = match[1];
              const time = timeField ? timeField.values[i] : null;
              tableFrame.fields[0].values.push(time);
              tableFrame.fields[1].values.push(traceId);
              tableFrame.fields[2].values.push(line);
              hasMatch = true;
            }
          }
        }
      }
    }
    if (hasMatch) {
      break;
    }
  }

  return tableFrame;
}

export function transformTraceList(
  response: DataQueryResponse,
  datasourceId: string,
  datasourceName: string,
  traceRegexs: string[]
): DataQueryResponse {
  response.data.forEach((data, index) => {
    const frame = createTableFrame(data, datasourceId, datasourceName, traceRegexs);
    response.data[index] = frame;
  });
  return response;
}

function getAttributeValue(value: collectorTypes.opentelemetryProto.common.v1.AnyValue): any {
  if (value.stringValue) {
    return value.stringValue;
  }

  if (value.boolValue !== undefined) {
    return Boolean(value.boolValue);
  }

  if (value.intValue !== undefined) {
    return Number.parseInt(value.intValue as any, 10);
  }

  if (value.doubleValue) {
    return Number.parseFloat(value.doubleValue as any);
  }

  if (value.arrayValue) {
    const arrayValue = [];
    for (const arValue of value.arrayValue.values) {
      arrayValue.push(getAttributeValue(arValue));
    }
    return arrayValue;
  }

  return '';
}

function resourceToProcess(resource: collectorTypes.opentelemetryProto.resource.v1.Resource | undefined) {
  const serviceTags: TraceKeyValuePair[] = [];
  let serviceName = 'OTLPResourceNoServiceName';
  if (!resource) {
    return { serviceName, serviceTags };
  }

  for (const attribute of resource.attributes) {
    if (attribute.key === SemanticResourceAttributes.SERVICE_NAME) {
      serviceName = attribute.value.stringValue || serviceName;
    }
    serviceTags.push({ key: attribute.key, value: getAttributeValue(attribute.value) });
  }

  return { serviceName, serviceTags };
}

function getSpanTags(span: collectorTypes.opentelemetryProto.trace.v1.Span): TraceKeyValuePair[] {
  const spanTags: TraceKeyValuePair[] = [];

  if (span.attributes) {
    for (const attribute of span.attributes) {
      spanTags.push({ key: attribute.key, value: getAttributeValue(attribute.value) });
    }
  }

  return spanTags;
}

function getSpanKind(span: collectorTypes.opentelemetryProto.trace.v1.Span) {
  let kind = undefined;
  if (span.kind) {
    const split = span.kind.toString().toLowerCase().split('_');
    kind = split.length ? split[split.length - 1] : span.kind.toString();
  }
  return kind;
}

function getReferences(span: collectorTypes.opentelemetryProto.trace.v1.Span) {
  const references: TraceSpanReference[] = [];
  if (span.links) {
    for (const link of span.links) {
      const { traceId, spanId } = link;
      const tags: TraceKeyValuePair[] = [];
      if (link.attributes) {
        for (const attribute of link.attributes) {
          tags.push({ key: attribute.key, value: getAttributeValue(attribute.value) });
        }
      }
      references.push({ traceID: traceId, spanID: spanId, tags });
    }
  }

  return references;
}

function getLogs(span: collectorTypes.opentelemetryProto.trace.v1.Span) {
  const logs: TraceLog[] = [];
  if (span.events) {
    for (const event of span.events) {
      const fields: TraceKeyValuePair[] = [];
      if (event.attributes) {
        for (const attribute of event.attributes) {
          fields.push({ key: attribute.key, value: getAttributeValue(attribute.value) });
        }
      }
      logs.push({ fields, timestamp: event.timeUnixNano / 1000000 });
    }
  }

  return logs;
}

export function transformFromOTLP(
  traceData: collectorTypes.opentelemetryProto.trace.v1.ResourceSpans[],
  nodeGraph = false
): DataQueryResponse {
  const frame = new MutableDataFrame({
    fields: [
      { name: 'traceID', type: FieldType.string },
      { name: 'spanID', type: FieldType.string },
      { name: 'parentSpanID', type: FieldType.string },
      { name: 'operationName', type: FieldType.string },
      { name: 'serviceName', type: FieldType.string },
      { name: 'kind', type: FieldType.string },
      { name: 'statusCode', type: FieldType.number },
      { name: 'statusMessage', type: FieldType.string },
      { name: 'instrumentationLibraryName', type: FieldType.string },
      { name: 'instrumentationLibraryVersion', type: FieldType.string },
      { name: 'traceState', type: FieldType.string },
      { name: 'serviceTags', type: FieldType.other },
      { name: 'startTime', type: FieldType.number },
      { name: 'duration', type: FieldType.number },
      { name: 'logs', type: FieldType.other },
      { name: 'references', type: FieldType.other },
      { name: 'tags', type: FieldType.other },
    ],
    meta: {
      preferredVisualisationType: 'trace',
      custom: {
        traceFormat: 'otlp',
      },
    },
  });
  try {
    for (const data of traceData) {
      const { serviceName, serviceTags } = resourceToProcess(data.resource);
      for (const librarySpan of data.instrumentationLibrarySpans) {
        for (const span of librarySpan.spans) {
          frame.add({
            traceID: span.traceId.length > 16 ? span.traceId.slice(16) : span.traceId,
            spanID: span.spanId,
            parentSpanID: span.parentSpanId || '',
            operationName: span.name || '',
            serviceName,
            kind: getSpanKind(span),
            statusCode: span.status?.code,
            statusMessage: span.status?.message,
            instrumentationLibraryName: librarySpan.instrumentationLibrary?.name,
            instrumentationLibraryVersion: librarySpan.instrumentationLibrary?.version,
            traceState: span.traceState,
            serviceTags,
            startTime: span.startTimeUnixNano! / 1000000,
            duration: (span.endTimeUnixNano! - span.startTimeUnixNano!) / 1000000,
            tags: getSpanTags(span),
            logs: getLogs(span),
            references: getReferences(span),
          } as TraceSpanRow);
        }
      }
    }
  } catch (error) {
    console.error(error);
    return { error: { message: 'JSON is not valid OpenTelemetry format: ' + error }, data: [] };
  }

  let data = [frame];
  if (nodeGraph) {
    data.push(...(createGraphFrames(frame) as MutableDataFrame[]));
  }

  return { data };
}

/**
 * Transforms trace dataframes to the OpenTelemetry format
 */
export function transformToOTLP(data: MutableDataFrame): {
  batches: collectorTypes.opentelemetryProto.trace.v1.ResourceSpans[];
} {
  let result: { batches: collectorTypes.opentelemetryProto.trace.v1.ResourceSpans[] } = {
    batches: [],
  };

  // Lookup object to see which batch contains spans for which services
  let services: { [key: string]: number } = {};

  for (let i = 0; i < data.length; i++) {
    const span = data.get(i);

    // Group spans based on service
    if (!services[span.serviceName]) {
      services[span.serviceName] = result.batches.length;
      result.batches.push({
        resource: {
          attributes: [],
          droppedAttributesCount: 0,
        },
        instrumentationLibrarySpans: [
          {
            spans: [],
          },
        ],
      });
    }

    let batchIndex = services[span.serviceName];

    // Populate resource attributes from service tags
    if (result.batches[batchIndex].resource!.attributes.length === 0) {
      result.batches[batchIndex].resource!.attributes = tagsToAttributes(span.serviceTags);
    }

    // Populate instrumentation library if it exists
    if (!result.batches[batchIndex].instrumentationLibrarySpans[0].instrumentationLibrary) {
      if (span.instrumentationLibraryName) {
        result.batches[batchIndex].instrumentationLibrarySpans[0].instrumentationLibrary = {
          name: span.instrumentationLibraryName,
          version: span.instrumentationLibraryVersion ? span.instrumentationLibraryVersion : '',
        };
      }
    }

    result.batches[batchIndex].instrumentationLibrarySpans[0].spans.push({
      traceId: span.traceID.padStart(32, '0'),
      spanId: span.spanID,
      parentSpanId: span.parentSpanID || '',
      traceState: span.traceState || '',
      name: span.operationName,
      kind: getOTLPSpanKind(span.kind) as any,
      startTimeUnixNano: span.startTime * 1000000,
      endTimeUnixNano: (span.startTime + span.duration) * 1000000,
      attributes: span.tags ? tagsToAttributes(span.tags) : [],
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
      status: getOTLPStatus(span),
      events: getOTLPEvents(span.logs),
      links: getOTLPReferences(span.references),
    });
  }

  return result;
}

function getOTLPSpanKind(kind: string): string | undefined {
  let spanKind = undefined;
  if (kind) {
    switch (kind) {
      case 'server':
        spanKind = 'SPAN_KIND_SERVER';
        break;
      case 'client':
        spanKind = 'SPAN_KIND_CLIENT';
        break;
      case 'producer':
        spanKind = 'SPAN_KIND_PRODUCER';
        break;
      case 'consumer':
        spanKind = 'SPAN_KIND_CONSUMER';
        break;
      case 'internal':
        spanKind = 'SPAN_KIND_INTERNAL';
        break;
    }
  }
  return spanKind;
}

/**
 * Converts key-value tags to OTLP attributes and removes tags added by Grafana
 */
function tagsToAttributes(tags: TraceKeyValuePair[]): collectorTypes.opentelemetryProto.common.v1.KeyValue[] {
  return tags.reduce<collectorTypes.opentelemetryProto.common.v1.KeyValue[]>(
    (attributes, tag) => [...attributes, { key: tag.key, value: toAttributeValue(tag) }],
    []
  );
}

/**
 * Returns the correct OTLP AnyValue based on the value of the tag value
 */
function toAttributeValue(tag: TraceKeyValuePair): collectorTypes.opentelemetryProto.common.v1.AnyValue {
  if (typeof tag.value === 'string') {
    return { stringValue: tag.value };
  } else if (typeof tag.value === 'boolean') {
    return { boolValue: tag.value };
  } else if (typeof tag.value === 'number') {
    if (tag.value % 1 === 0) {
      return { intValue: tag.value };
    } else {
      return { doubleValue: tag.value };
    }
  } else if (typeof tag.value === 'object') {
    if (Array.isArray(tag.value)) {
      const values: collectorTypes.opentelemetryProto.common.v1.AnyValue[] = [];
      for (const val of tag.value) {
        values.push(toAttributeValue(val));
      }

      return { arrayValue: { values } };
    }
  }
  return { stringValue: tag.value };
}

function getOTLPStatus(span: TraceSpanRow): SpanStatus | undefined {
  let status = undefined;
  if (span.statusCode !== undefined) {
    status = {
      code: span.statusCode,
      message: span.statusMessage ? span.statusMessage : '',
    };
  }
  return status;
}

function getOTLPEvents(logs: TraceLog[]): collectorTypes.opentelemetryProto.trace.v1.Span.Event[] | undefined {
  if (!logs || !logs.length) {
    return undefined;
  }

  let events: collectorTypes.opentelemetryProto.trace.v1.Span.Event[] = [];
  for (const log of logs) {
    let event: collectorTypes.opentelemetryProto.trace.v1.Span.Event = {
      timeUnixNano: log.timestamp * 1000000,
      attributes: [],
      droppedAttributesCount: 0,
      name: '',
    };
    for (const field of log.fields) {
      event.attributes!.push({
        key: field.key,
        value: toAttributeValue(field),
      });
    }
    events.push(event);
  }
  return events;
}

function getOTLPReferences(
  references: TraceSpanReference[]
): collectorTypes.opentelemetryProto.trace.v1.Span.Link[] | undefined {
  if (!references || !references.length) {
    return undefined;
  }

  let links: collectorTypes.opentelemetryProto.trace.v1.Span.Link[] = [];
  for (const ref of references) {
    let link: collectorTypes.opentelemetryProto.trace.v1.Span.Link = {
      traceId: ref.traceID,
      spanId: ref.spanID,
      attributes: [],
      droppedAttributesCount: 0,
    };
    if (ref.tags?.length) {
      for (const tag of ref.tags) {
        link.attributes?.push({
          key: tag.key,
          value: toAttributeValue(tag),
        });
      }
    }
    links.push(link);
  }
  return links;
}

export function transformTrace(response: DataQueryResponse, nodeGraph = false): DataQueryResponse {
  const frame: DataFrame = response.data[0];

  if (!frame) {
    return emptyDataQueryResponse;
  }

  let data = [...response.data];
  if (nodeGraph) {
    data.push(...createGraphFrames(frame));
  }

  return {
    ...response,
    data,
  };
}

export function createTableFrameFromSearch(data: TraceSearchMetadata[], instanceSettings: DataSourceInstanceSettings) {
  const frame = new MutableDataFrame({
    name: 'Traces',
    refId: 'traces',
    fields: [
      {
        name: 'traceID',
        type: FieldType.string,
        config: {
          unit: 'string',
          displayNameFromDS: 'Trace ID',
          links: [
            {
              title: 'Trace: ${__value.raw}',
              url: '',
              internal: {
                datasourceUid: instanceSettings.uid,
                datasourceName: instanceSettings.name,
                query: {
                  query: '${__value.raw}',
                  queryType: 'traceql',
                },
              },
            },
          ],
        },
      },
      { name: 'traceService', type: FieldType.string, config: { displayNameFromDS: 'Trace service' } },
      { name: 'traceName', type: FieldType.string, config: { displayNameFromDS: 'Trace name' } },
      { name: 'startTime', type: FieldType.time, config: { displayNameFromDS: 'Start time' } },
      { name: 'traceDuration', type: FieldType.number, config: { displayNameFromDS: 'Duration', unit: 'ms' } },
    ],
    meta: {
      preferredVisualisationType: 'table',
    },
  });
  if (!data?.length) {
    return frame;
  }
  // Show the most recent traces
  const traceData = data
    .sort((a, b) => parseInt(b?.startTimeUnixNano!, 10) / 1000000 - parseInt(a?.startTimeUnixNano!, 10) / 1000000)
    .map(transformToTraceData);

  for (const trace of traceData) {
    frame.add(trace);
  }

  return frame;
}

function transformToTraceData(data: TraceSearchMetadata) {
  return {
    traceID: data.traceID,
    startTime: parseInt(data.startTimeUnixNano!, 10) / 1000000,
    traceDuration: data.durationMs,
    traceService: data.rootServiceName || '',
    traceName: data.rootTraceName || '',
  };
}

export function createTableFrameFromTraceQlQuery(
  data: TraceSearchMetadata[],
  instanceSettings: DataSourceInstanceSettings
): DataFrame[] {
  const frame = createDataFrame({
    name: 'Traces',
    refId: 'traces',
    fields: [
      {
        name: 'traceID',
        type: FieldType.string,
        config: {
          unit: 'string',
          displayNameFromDS: 'Trace ID',
          custom: {
            width: 200,
          },
          links: [
            {
              title: 'Trace: ${__value.raw}',
              url: '',
              internal: {
                datasourceUid: instanceSettings.uid,
                datasourceName: instanceSettings.name,
                query: {
                  query: '${__value.raw}',
                  queryType: 'traceql',
                },
              },
            },
          ],
        },
      },
      {
        name: 'startTime',
        type: FieldType.time,
        config: {
          displayNameFromDS: 'Start time',
          custom: {
            width: 200,
          },
        },
      },
      { name: 'traceService', type: FieldType.string, config: { displayNameFromDS: 'Service' } },
      { name: 'traceName', type: FieldType.string, config: { displayNameFromDS: 'Name' } },
      {
        name: 'traceDuration',
        type: FieldType.number,
        config: {
          displayNameFromDS: 'Duration',
          unit: 'ms',
          custom: {
            width: 120,
          },
        },
      },
      {
        name: 'nested',
        type: FieldType.nestedFrames,
      },
    ],
    meta: {
      preferredVisualisationType: 'table',
    },
  });

  if (!data?.length) {
    return [frame];
  }
  frame.length = data.length;

  data
    // Show the most recent traces
    .sort((a, b) => parseInt(b?.startTimeUnixNano!, 10) / 1000000 - parseInt(a?.startTimeUnixNano!, 10) / 1000000)
    .forEach((trace) => {
      const traceData: TraceTableData = transformToTraceData(trace);
      frame.fields[0].values.push(traceData.traceID);
      frame.fields[1].values.push(traceData.startTime);
      frame.fields[2].values.push(traceData.traceService);
      frame.fields[3].values.push(traceData.traceName);
      frame.fields[4].values.push(traceData.traceDuration);

      if (trace.spanSets) {
        frame.fields[5].values.push(
          trace.spanSets.map((spanSet: Spanset) => {
            return traceSubFrame(trace, spanSet, instanceSettings);
          })
        );
      } else if (trace.spanSet) {
        frame.fields[5].values.push([traceSubFrame(trace, trace.spanSet, instanceSettings)]);
      }
    });

  return [frame];
}

const traceSubFrame = (
  trace: TraceSearchMetadata,
  spanSet: Spanset,
  instanceSettings: DataSourceInstanceSettings
): DataFrame => {
  const spanDynamicAttrs: Record<string, FieldDTO> = {};
  let hasNameAttribute = false;

  spanSet.attributes?.map((attr) => {
    spanDynamicAttrs[attr.key] = {
      name: attr.key,
      type: FieldType.string,
      config: { displayNameFromDS: attr.key },
    };
  });
  spanSet.spans.forEach((span) => {
    if (span.name) {
      hasNameAttribute = true;
    }
    span.attributes?.forEach((attr) => {
      spanDynamicAttrs[attr.key] = {
        name: attr.key,
        type: FieldType.string,
        config: { displayNameFromDS: attr.key },
      };
    });
  });

  const subFrame = new MutableDataFrame({
    fields: [
      {
        name: 'traceIdHidden',
        type: FieldType.string,
        config: {
          custom: { hidden: true },
        },
      },
      {
        name: 'spanID',
        type: FieldType.string,
        config: {
          unit: 'string',
          displayNameFromDS: 'Span ID',
          custom: {
            width: 200,
          },
          links: [
            {
              title: 'Span: ${__value.raw}',
              url: '',
              internal: {
                datasourceUid: instanceSettings.uid,
                datasourceName: instanceSettings.name,
                query: {
                  query: '${__data.fields.traceIdHidden}',
                  queryType: 'traceql',
                },
                panelsState: {
                  trace: {
                    spanId: '${__value.raw}',
                  },
                },
              },
            },
          ],
        },
      },
      {
        name: 'spanStartTime',
        type: FieldType.time,
        config: {
          displayNameFromDS: 'Start time',
          custom: {
            width: 200,
          },
        },
      },
      {
        name: 'name',
        type: FieldType.string,
        config: { displayNameFromDS: 'Name', custom: { hidden: !hasNameAttribute } },
      },
      ...Object.values(spanDynamicAttrs).sort((a, b) => a.name.localeCompare(b.name)),
      {
        name: 'duration',
        type: FieldType.number,
        config: {
          displayNameFromDS: 'Duration',
          unit: 'ns',
          custom: {
            width: 120,
          },
        },
      },
    ],
    meta: {
      preferredVisualisationType: 'table',
    },
  });

  const theme = createTheme();
  for (const field of subFrame.fields) {
    field.display = getDisplayProcessor({ field, theme });
  }

  spanSet.spans.forEach((span) => {
    subFrame.add(transformSpanToTraceData(span, spanSet, trace.traceID));
  });

  return subFrame;
};

interface TraceTableData {
  [key: string]: string | number | boolean | undefined; // dynamic attribute name
  traceID?: string;
  spanID?: string;
  startTime?: number;
  name?: string;
  traceDuration?: number;
}

function transformSpanToTraceData(span: Span, spanSet: Spanset, traceID: string): TraceTableData {
  const data: TraceTableData = {
    traceIdHidden: traceID,
    spanID: span.spanID,
    spanStartTime: parseInt(span.startTimeUnixNano, 10) / 1000000,
    duration: parseInt(span.durationNanos, 10),
    name: span.name,
  };

  let attrs: SpanAttributes[] = [];
  if (spanSet.attributes) {
    attrs = attrs.concat(spanSet.attributes);
  }
  if (span.attributes) {
    attrs = attrs.concat(span.attributes);
  }

  attrs.forEach((attr) => {
    if (attr.value.boolValue || attr.value.Value?.bool_value) {
      data[attr.key] = attr.value.boolValue || attr.value.Value?.bool_value;
    }
    if (attr.value.doubleValue || attr.value.Value?.double_value) {
      data[attr.key] = attr.value.doubleValue || attr.value.Value?.double_value;
    }
    if (attr.value.intValue || attr.value.Value?.int_value) {
      data[attr.key] = attr.value.intValue || attr.value.Value?.int_value;
    }
    if (attr.value.stringValue || attr.value.Value?.string_value) {
      data[attr.key] = attr.value.stringValue || attr.value.Value?.string_value;
    }
  });

  return data;
}

const emptyDataQueryResponse = {
  data: [
    new MutableDataFrame({
      fields: [
        {
          name: 'trace',
          type: FieldType.trace,
          values: [],
        },
      ],
      meta: {
        preferredVisualisationType: 'trace',
        custom: {
          traceFormat: 'otlp',
        },
      },
    }),
  ],
};

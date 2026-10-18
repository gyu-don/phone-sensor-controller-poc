export const MAX_GAME_EVENT_BYTES = 32 * 1024;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function withinJsonLimits(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++nodes > 1000 || current.depth > 16) return false;
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) return false;
    if (Array.isArray(current.value)) {
      if (current.value.length > 500) return false;
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      const entries = Object.values(current.value);
      for (const item of entries) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

export function validateGameEvent(value) {
  if (!isRecord(value)) return 'イベントはJSONオブジェクトにしてください。';
  if (typeof value.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.eventId)) {
    return 'eventIdは英数字、_、-で1〜128文字にしてください。';
  }
  if (value.name !== 'achievement.unlocked') return 'nameは achievement.unlocked にしてください。';
  if (typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp)) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.timestamp)) {
    return 'timestampはタイムゾーン付きのISO 8601日時にしてください。';
  }
  const data = value.data;
  if (!isRecord(data)) return 'dataはJSONオブジェクトにしてください。';
  if (typeof data.achievement_id !== 'string' || !data.achievement_id.trim()) return 'data.achievement_idを入力してください。';
  if (typeof data.achievement_name !== 'string' || !data.achievement_name.trim()) return 'data.achievement_nameを入力してください。';
  if (!Number.isInteger(data.attempts) || data.attempts < 0) return 'data.attemptsは0以上の整数にしてください。';
  if (typeof data.is_first_clear !== 'boolean') return 'data.is_first_clearはtrueまたはfalseにしてください。';
  if (typeof data.description !== 'string') return 'data.descriptionは文字列にしてください。';
  if (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== 'string') return 'cursorはnullまたは文字列にしてください。';
  if (!withinJsonLimits(value)) return 'JSONの入れ子は16階層・合計1000項目以内にしてください。';
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_GAME_EVENT_BYTES) return 'イベントは32KB以内にしてください。';
  return null;
}

export function normalizeGameEvent(value) {
  const error = validateGameEvent(value);
  if (error) throw new TypeError(error);
  return {
    eventId: value.eventId,
    name: value.name,
    timestamp: value.timestamp,
    data: value.data,
    cursor: null
  };
}

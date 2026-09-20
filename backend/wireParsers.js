// Wire-format parsing helpers, kept in their own dependency-free module
// (no spawn(), no server.listen()) specifically so they can be require()'d
// from a test file without starting a real server or spawning ./core.
//
// Background: FOLDER_TRANSFER_COMPLETE went from 2 numeric fields
// ("received=X|total=Y") to 3 ("received=X|failed=Y|total=Z") when
// per-file success tracking was fixed. The original positional parser
// (`const [id, receivedPart, totalPart] = payload.split('|')`) silently
// read the new "failed=" field as if it were "total=", so every folder
// transfer -- including fully successful ones -- was misreported as
// "partial". Parsing by key instead of position makes that whole class
// of bug impossible: adding a field, or reordering existing ones, can
// never shift what an existing field name resolves to.

// Parses a "key1=val1|key2=val2|..." wire payload into a plain object of
// integers, keyed by field name.
function parseKeyValueFields(payload) {
    const result = {};
    payload.split('|').forEach(part => {
        const eq = part.indexOf('=');
        if (eq === -1) return;
        const key = part.substring(0, eq);
        const value = part.substring(eq + 1);
        result[key] = parseInt(value, 10);
    });
    return result;
}

// Parses a full "id|key=val|key=val|..." line (the shape both
// FOLDER_TRANSFER_COMPLETE and FOLDER_SEND_COMPLETE use) into
// { id, fields: {...} }.
function parseIdAndFields(payload) {
    const firstPipe = payload.indexOf('|');
    if (firstPipe === -1) {
        return { id: payload, fields: {} };
    }
    const id = payload.substring(0, firstPipe);
    const rest = payload.substring(firstPipe + 1);
    return { id, fields: parseKeyValueFields(rest) };
}

module.exports = { parseKeyValueFields, parseIdAndFields };
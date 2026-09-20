const { parseKeyValueFields, parseIdAndFields } = require('../backend/wireParsers');

let failures = 0;

function expect(label, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    console.log((pass ? 'PASS: ' : 'FAIL: ') + label +
        (pass ? '' : ` -- got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`));
    if (!pass) failures++;
}

// The exact regression this suite exists to prevent: a fully successful
// folder transfer must never be misread as partial because of field order.
expect(
    'all-success FOLDER_TRANSFER_COMPLETE parses total correctly',
    parseIdAndFields('bugtest1|received=3|failed=0|total=3'),
    { id: 'bugtest1', fields: { received: 3, failed: 0, total: 3 } }
);

expect(
    'partial-failure FOLDER_TRANSFER_COMPLETE parses all three fields correctly',
    parseIdAndFields('bugtest1|received=2|failed=1|total=3'),
    { id: 'bugtest1', fields: { received: 2, failed: 1, total: 3 } }
);

expect(
    'FOLDER_SEND_COMPLETE (sent/failed/total) parses correctly',
    parseIdAndFields('sendtest1|sent=4|failed=0|total=4'),
    { id: 'sendtest1', fields: { sent: 4, failed: 0, total: 4 } }
);

// Field order independence -- the whole point of parsing by key.
expect(
    'field order does not affect the result',
    parseIdAndFields('x|total=5|failed=1|received=4'),
    { id: 'x', fields: { total: 5, failed: 1, received: 4 } }
);

// A field being added in the future (simulated here) should not break
// parsing of the fields that already exist.
expect(
    'an unrecognized extra field is harmless',
    parseIdAndFields('x|received=2|failed=0|total=2|elapsedMs=1500'),
    { id: 'x', fields: { received: 2, failed: 0, total: 2, elapsedMs: 1500 } }
);

expect(
    'a payload with no fields at all still returns a usable shape',
    parseIdAndFields('lonelyid'),
    { id: 'lonelyid', fields: {} }
);

expect(
    'parseKeyValueFields alone handles a bare field list',
    parseKeyValueFields('received=1|failed=2|total=3'),
    { received: 1, failed: 2, total: 3 }
);

console.log('');
if (failures === 0) {
    console.log('ALL TESTS PASSED');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
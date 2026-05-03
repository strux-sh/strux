#!/usr/bin/env bats

bats_load_library 'bats-assert'
bats_load_library 'bats-support'


setup() {
  export STRUX_INTROSPECT="./strux-introspect"
}

@test "strux-introspect outputs JSON without arguments" {
  run "$STRUX_INTROSPECT"

  assert_success
  assert_output --partial '"app":'
  assert_output --partial '"name":'
  assert_output --partial '"fields":'
  # Check that output is valid JSON by parsing it
  run bats_pipe echo "$output" \| jq .
  assert_success
}


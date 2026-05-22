#!/usr/bin/env bats

bats_load_library 'bats-assert'
bats_load_library 'bats-support'


setup_file() {
  export STRUX_INTROSPECT="$PWD/strux-introspect"
  export TEST_GO_FILE="$PWD/tests/vanilla-project/main.go"
}

@test "strux-introspect outputs JSON with Go file argument" {
  run "$STRUX_INTROSPECT" "$TEST_GO_FILE"

  assert_success
  assert_output --partial '"app":'
  assert_output --partial '"name":'
  assert_output --partial '"fields":'
  # Check that output is valid JSON by parsing it
  run bats_pipe echo "$output" \| jq .
  assert_success
}


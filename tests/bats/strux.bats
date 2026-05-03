#!/usr/bin/env bats

bats_load_library 'bats-assert'
bats_load_library 'bats-support'

setup() {
  export STRUX="./strux"
  export STRUX_INTROSPECT="./strux-introspect"
  export STRUX_VERSION=$(jq -r .version package.json)
}

@test "strux -V outputs version" {
  run "$STRUX" -V

  assert_success
  assert_output "$STRUX_VERSION"
}

@test "strux --version outputs version" {
  run "$STRUX" --version

  assert_success
  assert_output "$STRUX_VERSION"
}

@test "strux --help displays help" {
  run "$STRUX" --help

  assert_success
  assert_output --partial "Usage:"
  assert_output --partial "Strux"
  assert_output --partial "Options:"
  assert_output --partial "Commands:"
}

@test "strux -h displays help" {
  run "$STRUX" -h

  assert_success
  assert_output --partial "Usage:"
  assert_output --partial "Strux"
}

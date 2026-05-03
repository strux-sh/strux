#!/usr/bin/env bats

bats_load_library 'bats-assert'
bats_load_library 'bats-support'

setup_file() {
  export STRUX="$PWD/strux"
  export TEST_PROJECT="$PWD/tests/tmp/usb-test-project"
  rm -rf "$TEST_PROJECT"
  mkdir -p "$TEST_PROJECT"
}

teardown_file() {
  rm -rf "$TEST_PROJECT"
}

@test "strux usb --help displays help" {
  run "$STRUX" --verbose usb --help

  assert_success
  assert_output --partial "Usage:"
}

@test "strux usb add --help displays help" {
  run "$STRUX" --verbose usb add --help

  assert_success
  assert_output --partial "Usage:"
}

@test "strux usb list --help displays help" {
  run "$STRUX" --verbose usb list --help

  assert_success
  assert_output --partial "Usage:"
}

@test "strux usb fails without strux.yaml" {
  run "$STRUX" --verbose usb

  assert_failure
  assert_output --partial "strux.yaml"
}


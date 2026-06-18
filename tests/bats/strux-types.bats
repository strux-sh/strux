#!/usr/bin/env bats

bats_load_library 'bats-assert'
bats_load_library 'bats-support'

setup() {
  export STRUX="$PWD/strux"
  export WORKDIR="$BATS_FILE_TMPDIR"
  cp -r "samples" "$WORKDIR/sample-app"
}

teardown() {
  rm -rf "$WORKDIR/sample-app/frontend"
}

@test "strux types generates TypeScript definitions" {
  cd "$WORKDIR/sample-app"

  run "$STRUX" types

  assert_success
  assert_output --partial "Generated"
  assert_output --partial "Output:"
}

@test "strux types outputs correct method and field counts" {
  cd "$WORKDIR/sample-app"

  run "$STRUX" types

  assert_success
  assert_output --partial "4 methods"
  assert_output --partial "3 fields"
}

@test "strux types creates frontend/strux.d.ts" {
  cd "$WORKDIR/sample-app"

  run "$STRUX" types

  assert_success
  assert test -f "$WORKDIR/sample-app/frontend/src/strux.d.ts"
}

@test "strux types generates valid TypeScript declarations" {
  cd "$WORKDIR/sample-app"

  run "$STRUX" types

  assert_success
  run bunx tsc "$WORKDIR/sample-app/frontend/src/strux.d.ts"
  assert_success
}

@test "strux types fails when main.go is missing" {
  cd "$BATS_FILE_TMPDIR"

  run "$STRUX" types

  assert_failure
  assert_output --partial "main.go not found"
}

@test "strux types --help displays help" {
  run "$STRUX" types --help

  assert_success
  assert_output --partial "Usage:"
  assert_output --partial "Generate TypeScript type definitions"
}

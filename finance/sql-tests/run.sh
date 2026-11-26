#!/usr/bin/env bash
# Tests supabase-finance.sql on a local PostgreSQL (NOT on Supabase): owners only, audit, month closing.
# Usage: PGHOST=/tmp PGPORT=54322 PGUSER=postgres ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
P="psql -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists fin_rls_test with (force)" -c "create database fin_rls_test" >/dev/null
$P -d fin_rls_test -f app_stub.sql >/dev/null 2>&1
$P -d fin_rls_test -f ../../supabase-finance.sql >/dev/null 2>&1
$P -d fin_rls_test -f ../../supabase-finance.sql >/dev/null 2>&1   # idempotent
$P -d fin_rls_test -f rls_test.sql

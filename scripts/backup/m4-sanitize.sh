#!/usr/bin/env bash
# DPG-42: map a PostgreSQL client/server error log to a fixed error class. Never prints the log itself: server messages
# can contain object names, constraint details or row values. Usage: m4_error_class <log-file> -> one token on stdout.
m4_error_class() {
  local f="$1"
  [ -s "$f" ] || { echo unknown_error; return; }
  if grep -Eqi 'permission denied' "$f"; then echo permission_denied
  elif grep -Eqi 'role "[^"]*" does not exist' "$f"; then echo missing_role
  elif grep -Eqi '(relation|schema|function|type|extension) "[^"]*" does not exist|does not exist' "$f"; then echo missing_object
  elif grep -Eqi 'duplicate key|already exists' "$f"; then echo duplicate_object
  elif grep -Eqi 'violates|constraint' "$f"; then echo constraint_violation
  elif grep -Eqi 'could not connect|connection refused|timeout|terminating connection|server closed' "$f"; then echo connection_error
  elif grep -Eqi 'syntax error' "$f"; then echo syntax_error
  elif grep -Eqi 'invalid snapshot|snapshot' "$f"; then echo snapshot_error
  elif grep -Eqi 'unexpected end of file|truncated|input file appears|not a valid archive|could not read' "$f"; then echo archive_error
  else echo other_error; fi
}

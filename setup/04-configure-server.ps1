# Phase 5 - configure the freshly installed server.
#
# SUPERSEDED. This script used to hold five settings inline with absolute paths
# baked in. It has been replaced by the pair:
#
#   export-settings.ps1   captures the live configs into server-settings.conf
#   apply-settings.ps1    replays that file onto any machine
#
# The old version knew about 5 settings. There are now 31, and hardcoding them
# in two places is exactly how a machine move loses them. This forwards so the
# documented Phase 5 step still works.

$ErrorActionPreference = 'Stop'
Write-Output "Phase 5 configure -> delegating to apply-settings.ps1 -FromDist"
Write-Output ""
& (Join-Path $PSScriptRoot 'apply-settings.ps1') -FromDist @args

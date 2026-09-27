#!/usr/bin/env bash
# Regenerates the area dropdown in every issue form from .github/issue-routing.yml.
# Runs automatically (see .github/workflows/issue-routing-sync.yml); needs yq v4 to run by hand.
set -euo pipefail

config=.github/issue-routing.yml
export FIELD="$(yq '.area_field' "$config")"

for form in .github/ISSUE_TEMPLATE/*.yml; do
	[ "$(basename "$form")" = config.yml ] && continue
	yq -i '(.body[] | select(.type == "dropdown" and .attributes.label == strenv(FIELD)) | .attributes.options) =
		([load("'"$config"'").labels[] | select(has("area")) | .area] | . style="")' "$form"
done

// Labels and assigns issues according to .github/issue-routing.yml.
//
// route() runs from .github/workflows/issue-routing.yml through actions/github-script.
// Running this file directly validates the config against the issue forms:
//   node issue-routing.js validate <config.json> <form.json>...
// (the YAML files are converted to JSON with yq first, see the workflow).

// GitHub refuses more than 10 assignees on an issue.
const MAX_ASSIGNEES = 10;

// Returns the answer given to a field of an issue form, or null.
// Forms render as "### <label>\n\n<answer>\n\n### <next label>...".
function formAnswer(body, field) {
	const lines = (body || '').split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === `### ${field}`);
	if (start === -1) {
		return null;
	}

	const answer = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('### ')) {
			break;
		}
		answer.push(line);
	}

	const value = answer.join('\n').trim();
	return value && value !== '_No response_' ? value : null;
}

// Reads the routing config and derives the dropdown areas and the fallback label.
function loadConfig(raw) {
	const labels = raw.labels || {};
	const areas = {};
	let fallback = null;
	for (const [label, entry] of Object.entries(labels)) {
		if (entry && entry.area) {
			areas[entry.area] = label;
		}
		if (entry && entry.fallback) {
			fallback = fallback || label;
		}
	}
	return { areaField: raw.area_field, labels, areas, fallback };
}

async function route({ github, context, core, getOctokit }) {
	const config = loadConfig(JSON.parse(require('fs').readFileSync(process.env.ROUTING_CONFIG, 'utf8')));

	const { owner, repo } = context.repo;
	const issue_number = context.payload.issue.number;
	const summary = [];

	// Team membership is organisation data the workflow's GITHUB_TOKEN cannot read,
	// so it is fetched with the GitHub App token when one is configured.
	const teamClient = process.env.TEAM_TOKEN ? getOctokit(process.env.TEAM_TOKEN) : null;
	if (!teamClient) {
		core.warning('No team token available: set the ISSUE_ROUTING_APP_CLIENT_ID variable and ISSUE_ROUTING_APP_PRIVATE_KEY secret. Only `users` from the config can be assigned.');
	}

	const teamCache = new Map();
	async function teamMembers(slug) {
		if (!teamClient) {
			return [];
		}
		if (!teamCache.has(slug)) {
			try {
				const members = await teamClient.paginate(teamClient.rest.teams.listMembersInOrg, {
					org: owner,
					team_slug: slug,
					per_page: 100,
				});
				teamCache.set(slug, members.map((member) => member.login));
			} catch (error) {
				core.warning(`Could not read members of team "${slug}": ${error.message}`);
				teamCache.set(slug, []);
			}
		}
		return teamCache.get(slug);
	}

	async function peopleFor(entry) {
		const people = [...(entry.users || [])];
		for (const slug of entry.teams || []) {
			people.push(...await teamMembers(slug));
		}
		return people;
	}

	async function ensureLabel(name) {
		const entry = config.labels[name] || {};
		try {
			await github.rest.issues.getLabel({ owner, repo, name });
		} catch (error) {
			if (error.status !== 404) {
				throw error;
			}
			await github.rest.issues.createLabel({
				owner,
				repo,
				name,
				color: String(entry.color || 'ededed').replace(/^#/, ''),
				description: entry.description || '',
			});
			summary.push(`Created label \`${name}\``);
		}
	}

	async function addLabels(names) {
		for (const name of names) {
			await ensureLabel(name);
		}
		await github.rest.issues.addLabels({ owner, repo, issue_number, labels: names });
		summary.push(`Added labels: ${names.map((name) => `\`${name}\``).join(', ')}`);
	}

	async function assign(people, reason) {
		const current = new Set(assignees.map((login) => login.toLowerCase()));
		const wanted = [...new Set(people)].filter((login) => !current.has(login.toLowerCase()));
		const room = MAX_ASSIGNEES - assignees.length;
		if (wanted.length > room) {
			core.warning(`Only ${room} more assignee(s) allowed on an issue; skipping ${wanted.slice(room).join(', ')}.`);
		}
		const toAdd = wanted.slice(0, Math.max(room, 0));
		if (!toAdd.length) {
			return;
		}

		// Users without access to the repository are silently dropped by GitHub,
		// so the response is the source of truth for who was actually assigned.
		const { data } = await github.rest.issues.addAssignees({ owner, repo, issue_number, assignees: toAdd });
		assignees = data.assignees.map((user) => user.login);
		const added = toAdd.filter((login) => assignees.some((a) => a.toLowerCase() === login.toLowerCase()));
		const dropped = toAdd.filter((login) => !added.includes(login));
		if (added.length) {
			summary.push(`Assigned ${added.map((login) => `@${login}`).join(', ')} (${reason})`);
		}
		if (dropped.length) {
			core.warning(`Could not assign ${dropped.join(', ')}; do they have access to ${owner}/${repo}?`);
		}
	}

	// Always work from the current state, not the (possibly stale) event payload.
	const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number });
	let labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
	let assignees = issue.assignees.map((user) => user.login);

	// Tidying up a closed issue should not bring the fallback back.
	if (issue.state === 'closed' && ['unlabeled', 'unassigned'].includes(context.payload.action)) {
		return;
	}

	// 1. Label from the form's area dropdown.
	if (['opened', 'reopened'].includes(context.payload.action)) {
		const area = formAnswer(issue.body, config.areaField);
		if (area) {
			const label = config.areas[area];
			if (!label) {
				core.warning(`Area "${area}" is not the \`area\` of any label in the routing config.`);
			} else if (!labels.includes(label)) {
				await addLabels([label]);
				labels.push(label);
			}
		}
	}

	// 2. Assign the teams of routed labels. On `labeled` only the new label counts,
	//    so people removed by hand for earlier labels are not re-added; `unlabeled`
	//    and `unassigned` only need the fallback check below.
	let routedLabels = [];
	if (['opened', 'reopened'].includes(context.payload.action)) {
		routedLabels = labels;
	} else if (context.payload.action === 'labeled' && labels.includes(context.payload.label.name)) {
		routedLabels = [context.payload.label.name];
	}
	for (const label of routedLabels) {
		const entry = config.labels[label];
		if (entry) {
			await assign(await peopleFor(entry), `label \`${label}\``);
		}
	}

	// 3. Every issue gets at least one label and one assignee.
	const hasRoutedLabel = labels.some((label) => config.labels[label] && label !== config.fallback);
	if (!labels.length) {
		await addLabels([config.fallback]);
		labels.push(config.fallback);
	} else if (hasRoutedLabel && labels.includes(config.fallback)) {
		await github.rest.issues.removeLabel({ owner, repo, issue_number, name: config.fallback });
		labels = labels.filter((label) => label !== config.fallback);
		summary.push(`Removed label \`${config.fallback}\` (issue is routed)`);
	}

	if (!assignees.length) {
		await assign(await peopleFor(config.labels[config.fallback]), 'fallback');
	}
	if (!assignees.length) {
		core.setFailed(`Nobody could be assigned to #${issue_number}. Check the teams in the routing config and the app token.`);
	}

	await core.summary
		.addHeading(`Issue #${issue_number} (${context.payload.action})`, 3)
		.addList(summary.length ? summary : ['Nothing to change'])
		.write();
}

// Returns a list of problems with the config, checked against the issue forms.
function validate(raw, forms) {
	const errors = [];
	const config = loadConfig(raw);
	const entries = Object.entries(config.labels);

	if (!config.areaField) {
		errors.push('`area_field` is missing.');
	}
	if (!entries.length) {
		errors.push('No `labels` are defined.');
	}

	const fallbacks = entries.filter(([, entry]) => entry && entry.fallback).map(([label]) => label);
	if (fallbacks.length !== 1) {
		errors.push(`Exactly one label needs \`fallback: true\`; found ${fallbacks.length}.`);
	}

	const seenAreas = new Set();
	for (const [label, entry] of entries) {
		if (!entry || (!(entry.teams || []).length && !(entry.users || []).length)) {
			errors.push(`Label "${label}" has no teams or users.`);
		}
		if (entry && entry.area) {
			if (seenAreas.has(entry.area)) {
				errors.push(`Area "${entry.area}" is used by more than one label.`);
			}
			seenAreas.add(entry.area);
		}
	}

	// The dropdowns are generated from the config, so this only fails when a form
	// was edited by hand or the sync did not run.
	const expected = Object.keys(config.areas);
	for (const { file, form } of forms) {
		const dropdown = (form.body || []).find((field) =>
			field.type === 'dropdown' && field.attributes && field.attributes.label === config.areaField);
		if (!dropdown) {
			errors.push(`${file}: no dropdown labelled "${config.areaField}".`);
		} else if (JSON.stringify(dropdown.attributes.options || []) !== JSON.stringify(expected)) {
			errors.push(`${file}: dropdown options do not match the areas in the routing config.`);
		}
	}

	return errors;
}

module.exports = { route, validate, formAnswer };

if (require.main === module) {
	const fs = require('fs');
	const [command, configFile, ...formFiles] = process.argv.slice(2);
	if (command !== 'validate' || !configFile) {
		console.error('Usage: node issue-routing.js validate <config.json> <form.json>...');
		process.exit(2);
	}

	const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	const errors = validate(read(configFile), formFiles.map((file) => ({ file, form: read(file) })));
	for (const error of errors) {
		console.log(`::error::${error}`);
	}
	console.log(errors.length ? `${errors.length} problem(s) found.` : 'Routing config is valid.');
	process.exit(errors.length ? 1 : 0);
}

// src/server/getRepos.js
import { Octokit } from '@octokit/rest';

export async function getRepos() {
    const octokit = new Octokit();
    try {
        const { data } = await octokit.repos.listForUser({
            username: 'baladithyab', // Replace with your GitHub username
            type: 'all',
            sort: 'pushed',
            per_page: 100,
        });

        const topRepos = data
            .sort((a, b) => Date.parse(b.updated_at!) - Date.parse(a.updated_at!))
            .slice(0, 5);

        return topRepos;
    } catch (error) {
        console.error('Error fetching repositories:', error);
        return [];
    }
}

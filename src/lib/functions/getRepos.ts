// src/server/getRepos.ts
import { Octokit } from '@octokit/rest';

import { type Repo } from '@/components/RepoAccordion'

export async function getRepos(): Promise<Repo[]> {
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
            .slice(0, 5)
            .map(repo => ({
                name: repo.name,
                html_url: repo.html_url,
                description: repo.description!,
                updated_at: repo.updated_at!,
            }));

        return topRepos;
    } catch (error) {
        console.error('Error fetching repositories:', error);
        return [];
    }
}

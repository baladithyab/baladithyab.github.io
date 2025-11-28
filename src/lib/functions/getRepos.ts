// src/server/getRepos.ts
import { type Repo } from '@/components/RepoAccordion'

interface GitHubRepo {
    name: string
    html_url: string
    description: string | null
    updated_at: string
    fork: boolean
    private: boolean
}

export async function getRepos(): Promise<Repo[]> {
    try {
        // Use native fetch instead of Octokit for better Cloudflare Workers compatibility
        const response = await fetch(
            'https://api.github.com/users/baladithyab/repos?type=all&sort=pushed&per_page=100',
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'codeseys-website'
                }
            }
        )

        if (!response.ok) {
            console.error('GitHub API error:', response.status, response.statusText)
            return []
        }

        const data: GitHubRepo[] = await response.json()

        const topRepos = data
            .filter(repo => !repo.fork && !repo.private) // Exclude forks and private repos
            .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
            .slice(0, 5)
            .map(repo => ({
                name: repo.name,
                html_url: repo.html_url,
                description: repo.description || 'No description',
                updated_at: repo.updated_at,
            }))

        return topRepos
    } catch (error) {
        console.error('Error fetching repositories:', error)
        return []
    }
}

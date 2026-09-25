# Access Pattern

![Access Pattern](access-pattern.png)

```mermaid
graph LR
    subgraph Identities[Identities]
        direction TB
        OrgAdmin([Org Admin]):::orgAdmin
        ProjAdmin([Project Admin]):::projAdmin
        Dev([Developer]):::dev
    end

    subgraph Resources[Resources]
        direction TB
        Org[Organisation<br/>folders, seed &amp; cicd, all projects]:::resource
        DevProj[dev projects]:::resource
        ProdProj[prod projects]:::resource
    end

    OrgAdmin ==>|full access| Org
    ProjAdmin ==>|full access| DevProj
    ProjAdmin ==>|full access| ProdProj
    Dev ==>|broad access| DevProj
    Dev -.->|read-only| ProdProj

    ProjAdmin -.-o|may be the same person<br/>different identities| Dev

    classDef orgAdmin fill:#ede7f6,stroke:#4527a0,stroke-width:2px,color:#311b92;
    classDef projAdmin fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#0d47a1;
    classDef dev fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20;
    classDef resource fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#e65100;
```

A three-tier access model:

- **Org Admin** — full access to everything at the organisation level (all folders and projects, including `seed` and `cicd`).
- **Project Admin** — full access across all service projects in every environment.
- **Developer** — broad access to `dev` projects, read-only to `prod` projects (thick edge = broad/full access, dotted edge = read-only).

Developers and Project Admins may be the same people, but operate under different identities depending on the level of access required.

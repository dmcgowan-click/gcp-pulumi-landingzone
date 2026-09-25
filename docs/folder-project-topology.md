# Folder / Project Topology

![Folder / Project Topology](folder-project-topology.png)

```mermaid
graph TD
    Org([Organisation]):::mandatory

    Org --> Common[common folder]:::mandatory
    Org --> Envs[environment folders<br/>e.g. dev, prod, ...]:::mandatory

    Common --> Seed[seed project]:::stdProject
    Common -.-> Cicd[cicd project]:::optStdProject

    Envs -.-> Svc[service projects<br/>per initiative + environment]:::optSvcProject

    subgraph Legend[Legend]
        direction LR
        L1[Mandatory folder]:::mandatory
        L2[Standard project]:::stdProject
        L3[Optional standard project]:::optStdProject
        L4[Optional service project]:::optSvcProject
    end

    classDef mandatory fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#0d47a1;
    classDef stdProject fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20;
    classDef optStdProject fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,stroke-dasharray:5 3,color:#1b5e20;
    classDef optSvcProject fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,stroke-dasharray:5 3,color:#e65100;
```

Solid borders are mandatory; dashed borders are optional and enabled per your organisation's needs. **Standard projects** (green — `seed`, `cicd`) are created via the `project` module and live under the `common` folder. **Service projects** (orange) are created by the project-factory via the `service-project` module and live under environment folders, one per initiative + environment.

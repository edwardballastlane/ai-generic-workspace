---
name: nestjs
description: NestJS backend patterns. Use when building NestJS APIs, modules, controllers, services, DTOs, guards, interceptors, or TypeORM/Prisma integration.
---

# NestJS Patterns

## Reference Guide

| Topic | Reference | When |
|-------|-----------|------|
| Controllers | [references/controllers.md](references/controllers.md) | Routes, Swagger, validation pipes |
| Services | [references/services.md](references/services.md) | DI, providers, async patterns |
| DTOs | [references/dtos.md](references/dtos.md) | Validation, transforms, nested objects |
| Testing | [references/testing.md](references/testing.md) | Unit tests, E2E, mocking |

## Critical Rules

- **ALWAYS** use DI for services (never `new Service()`)
- **ALWAYS** validate with class-validator DTOs
- **ALWAYS** use HTTP exceptions for errors
- **NEVER** use `any` type
- **NEVER** hardcode config values

## Minimal Patterns

```typescript
// Module
@Module({
  imports: [TypeOrmModule.forFeature([Entity])],
  controllers: [EntityController],
  providers: [EntityService],
  exports: [EntityService],
})
export class EntityModule {}

// Controller
@Controller('entities')
@ApiTags('entities')
export class EntityController {
  constructor(private readonly service: EntityService) {}

  @Post()
  @ApiOperation({ summary: 'Create' })
  create(@Body() dto: CreateEntityDto) {
    return this.service.create(dto);
  }
}

// Service
@Injectable()
export class EntityService {
  constructor(@InjectRepository(Entity) private repo: Repository<Entity>) {}

  async create(dto: CreateEntityDto) {
    return this.repo.save(this.repo.create(dto));
  }
}
```

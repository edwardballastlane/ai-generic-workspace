# Services & Dependency Injection

## Contents
- Service Pattern (CRUD, error handling)
- Module with Providers
- Custom Providers (value, factory, class)
- Async Module Configuration
- Scoped Providers

---

## Service Pattern

```typescript
import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly repo: Repository<User>,
    private readonly emailService: EmailService,
  ) {}

  async create(dto: CreateUserDto): Promise<User> {
    try {
      const user = this.repo.create(dto);
      const saved = await this.repo.save(user);
      await this.emailService.sendWelcome(saved.email);
      return saved;
    } catch (error) {
      if (error.code === '23505') {
        throw new ConflictException('Email already exists');
      }
      this.logger.error(`Failed to create user: ${error.message}`);
      throw error;
    }
  }

  async findOne(id: string): Promise<User> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    Object.assign(user, dto);
    return this.repo.save(user);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`User ${id} not found`);
    }
  }
}
```

## Module with Providers

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],  // Make available to other modules
})
export class UsersModule {}
```

## Custom Providers

```typescript
// Value provider
{ provide: 'API_KEY', useValue: process.env.API_KEY }

// Factory provider
{
  provide: 'CONFIG',
  useFactory: (configService: ConfigService) => ({
    apiUrl: configService.get('API_URL'),
    timeout: configService.get('TIMEOUT'),
  }),
  inject: [ConfigService],
}

// Class provider (alternative implementation)
{
  provide: EmailService,
  useClass: process.env.NODE_ENV === 'test' ? MockEmailService : EmailService,
}
```

## Async Module Configuration

```typescript
@Module({})
export class DatabaseModule {
  static forRootAsync(options: DatabaseModuleAsyncOptions): DynamicModule {
    return {
      module: DatabaseModule,
      imports: options.imports,
      providers: [
        {
          provide: 'DATABASE_CONNECTION',
          useFactory: options.useFactory,
          inject: options.inject,
        },
      ],
      exports: ['DATABASE_CONNECTION'],
    };
  }
}
```

## Scoped Providers

```typescript
// Request-scoped (new instance per request)
@Injectable({ scope: Scope.REQUEST })
export class RequestScopedService {
  constructor(@Inject(REQUEST) private request: Request) {}
}

// Transient (new instance each injection)
@Injectable({ scope: Scope.TRANSIENT })
export class TransientService {}
```

# Testing Patterns

## Contents
- Unit Test for Service
- Controller Unit Test
- E2E Test
- Mocking External Services

---

## Unit Test for Service

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';

describe('UsersService', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;

  const mockUser: User = {
    id: 'uuid-1',
    email: 'test@example.com',
    name: 'Test User',
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            delete: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    repo = module.get(getRepositoryToken(User));
  });

  describe('create', () => {
    it('should create a user', async () => {
      repo.create.mockReturnValue(mockUser);
      repo.save.mockResolvedValue(mockUser);

      const result = await service.create({ email: 'test@example.com', name: 'Test' });

      expect(repo.create).toHaveBeenCalledWith({ email: 'test@example.com', name: 'Test' });
      expect(result).toEqual(mockUser);
    });
  });

  describe('findOne', () => {
    it('should return user if found', async () => {
      repo.findOne.mockResolvedValue(mockUser);

      const result = await service.findOne('uuid-1');

      expect(result).toEqual(mockUser);
    });

    it('should throw NotFoundException if not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.findOne('uuid-1')).rejects.toThrow(NotFoundException);
    });
  });
});
```

## Controller Unit Test

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let service: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    service = module.get(UsersService);
  });

  it('should call service.create with dto', async () => {
    const dto = { email: 'test@example.com', name: 'Test' };
    service.create.mockResolvedValue({ id: '1', ...dto });

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result.id).toBe('1');
  });
});
```

## E2E Test

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('UsersController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /users', () => {
    it('should create user', () => {
      return request(app.getHttpServer())
        .post('/users')
        .send({ email: 'test@example.com', name: 'Test' })
        .expect(201)
        .expect((res) => {
          expect(res.body.email).toBe('test@example.com');
        });
    });

    it('should return 400 for invalid email', () => {
      return request(app.getHttpServer())
        .post('/users')
        .send({ email: 'invalid', name: 'Test' })
        .expect(400);
    });
  });

  describe('GET /users/:id', () => {
    it('should return 404 for non-existent user', () => {
      return request(app.getHttpServer())
        .get('/users/non-existent-id')
        .expect(404);
    });
  });
});
```

## Mocking External Services

```typescript
const mockEmailService = {
  sendWelcome: jest.fn().mockResolvedValue(true),
  sendPasswordReset: jest.fn().mockResolvedValue(true),
};

const module = await Test.createTestingModule({
  providers: [
    UsersService,
    { provide: EmailService, useValue: mockEmailService },
  ],
}).compile();
```

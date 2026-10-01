# DTOs & Validation

## Contents
- Basic DTO with Validation
- Update DTO with PartialType
- Nested Objects
- Custom Validation
- Transform Decorators
- Response DTO

---

## Basic DTO with Validation

```typescript
import { IsString, IsEmail, IsOptional, MinLength, IsEnum, ValidateNested, IsArray } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ enum: UserRole, default: UserRole.USER })
  @IsEnum(UserRole)
  role: UserRole = UserRole.USER;
}
```

## Update DTO with PartialType

```typescript
import { PartialType, OmitType, PickType } from '@nestjs/swagger';

// All fields optional
export class UpdateUserDto extends PartialType(CreateUserDto) {}

// Omit specific fields
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['email'] as const)
) {}

// Pick specific fields
export class UpdatePasswordDto extends PickType(CreateUserDto, ['password'] as const) {}
```

## Nested Objects

```typescript
export class CreateOrderDto {
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  @IsArray()
  items: OrderItemDto[];

  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress: AddressDto;
}

export class OrderItemDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}
```

## Custom Validation

```typescript
import { ValidatorConstraint, ValidatorConstraintInterface, Validate } from 'class-validator';

@ValidatorConstraint({ name: 'isValidSlug', async: false })
export class IsValidSlug implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  }

  defaultMessage(): string {
    return 'Slug must be lowercase with hyphens only';
  }
}

export class CreatePostDto {
  @Validate(IsValidSlug)
  slug: string;
}
```

## Transform Decorators

```typescript
import { Transform } from 'class-transformer';

export class QueryDto {
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  page: number = 1;

  @Transform(({ value }) => value?.toLowerCase().trim())
  @IsString()
  search?: string;

  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  active?: boolean;
}
```

## Response DTO

```typescript
import { Exclude, Expose } from 'class-transformer';

export class UserResponseDto {
  @Expose()
  id: string;

  @Expose()
  email: string;

  @Expose()
  name: string;

  @Exclude()
  password: string;

  @Exclude()
  deletedAt: Date;

  constructor(partial: Partial<UserResponseDto>) {
    Object.assign(this, partial);
  }
}

// In controller
@Get(':id')
@UseInterceptors(ClassSerializerInterceptor)
findOne(@Param('id') id: string) {
  const user = await this.usersService.findOne(id);
  return new UserResponseDto(user);
}
```
